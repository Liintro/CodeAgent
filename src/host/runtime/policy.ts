// Harness 策略包：自改进循环唯一可以修改的产品行为。
// 一个策略包目录 = params.json（白名单参数）+ playbook.md（追加到系统提示的经验手册）+ 可选 manifest.json（谱系元数据，不参与身份）。
// 身份 policyId 只由生效内容（参数 + 手册）决定：内容相同的两个包就是同一个策略。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_MAX_REPAIRS } from '../../shared/constants.js';

const int = (min: number, max: number) => z.number().int().min(min).max(max).optional();
const num = (min: number, max: number) => z.number().min(min).max(max).optional();

// 每一项都可省略；省略时取 DEFAULT_SETTINGS 中的值（等于未引入策略包时的行为）。
const paramsSchema = z.strictObject({
  /** shell 命令超时上限（秒）：模型请求更长或不设超时时按此值执行；省略时不设上限。 */
  shellMaxTimeoutSec: int(30, 3600),
  repair: z.strictObject({
    /** 新任务的自动修复轮数上限（用户可在验收设置里修改）。 */
    defaultMaxRepairs: int(0, 10),
    /** 同一失败（失败 hash 相同，不论代码是否改变）连续出现这么多次就停止修复，转为文字总结。 */
    noProgressRepeats: int(2, 10),
  }).optional(),
  compaction: z.strictObject({
    /** 为模型输出预留的窗口比例与上限；不少于一次完整输出加安全余量。 */
    reserveRatio: num(0.05, 0.5),
    reserveCapTokens: int(1024, 131072),
    /** 预留量最多占窗口的比例。 */
    reserveMaxRatio: num(0.1, 0.8),
    /** 压缩后原样保留的最近对话 token 数及其窗口比例上限。 */
    keepRecentTokens: int(1000, 200000),
    keepRecentRatio: num(0.05, 0.8),
    /** 分层压缩：先省略较早的工具结果，仍超出才摘要；关闭时只摘要（评测开/关对照用）。 */
    layers: z.boolean().optional(),
    /** 裁剪时原样保留的最近工具结果数。 */
    keepToolResults: int(1, 64),
    /** 摘要请求里每个工具结果最多带多少字符。 */
    summaryToolResultChars: int(200, 20000),
  }).optional(),
  recall: z.strictObject({
    maxItems: int(0, 20),
    candidates: int(1, 200),
    /** 召回文本（记忆槽位）的 token 上限与窗口比例上限。 */
    budgetTokens: int(0, 8000),
    budgetRatio: num(0, 0.2),
    minScore: num(0, 10),
    driftedMinRelevance: num(0, 10),
    driftedWeight: num(0, 1),
    weights: z.strictObject({
      path: num(0, 10), failure: num(0, 10), identifier: num(0, 10), phrase: num(0, 10),
      confirmed: num(0, 10), recency: num(0, 10), rank: num(0, 10),
      /** 用过该记忆的 Run 每通过一次加权、每失败或被还原一次降权。 */
      success: num(0, 10), unsuccessful: num(0, 10),
    }).optional(),
    /** 效果加减权的总量上限。 */
    effectCap: num(0, 10),
    /** “变更”记忆在路径没命中时的相关度系数。 */
    changeWeight: num(0, 1),
    /** memory_search 一次最多返回的条目数。 */
    searchLimit: int(1, 30),
    minPhraseGrams: int(1, 20),
    phraseFull: int(1, 40),
    maxQueryTerms: int(1, 200),
    excerptChars: int(0, 4000),
  }).optional(),
  output: z.strictObject({
    /** 导航工具单次输出的字符上限，以及 find_symbol 扫描的文件数上限。 */
    navigationChars: int(1024, 262144),
    navigationFiles: int(100, 50000),
    /** doc_read 单次输出的字符上限。 */
    documentChars: int(1024, 262144),
    /** 验证失败反馈里保留的输出尾部行数与字符数。 */
    verificationTailLines: int(20, 2000),
    verificationTailChars: int(1024, 262144),
  }).optional(),
  kernel: z.strictObject({
    /** 同一条回复里的只读工具调用并发执行；关闭时全部逐个执行。 */
    parallelReadOnlyTools: z.boolean().optional(),
    maxParallelTools: int(1, 16),
  }).optional(),
  permission: z.strictObject({
    /** “允许本任务”授权的命令前缀最多取几个单词（npm run build 为 3）。 */
    grantPrefixWords: int(1, 5),
  }).optional(),
  budget: z.strictObject({
    /** 每个 Run 的 token、工具调用次数与墙钟时间上限：超出后停止修改，转为不调用工具的文字总结。 */
    maxTokens: int(10_000, 100_000_000),
    maxToolCalls: int(10, 100_000),
    maxWallSeconds: int(60, 86_400),
  }).optional(),
});

export type PolicyParams = z.infer<typeof paramsSchema>;

export const DEFAULT_SETTINGS = {
  shellMaxTimeoutSec: undefined as number | undefined,
  repair: { defaultMaxRepairs: DEFAULT_MAX_REPAIRS, noProgressRepeats: 3 },
  compaction: { reserveRatio: 0.25, reserveCapTokens: 16384, reserveMaxRatio: 0.5, keepRecentTokens: 20000, keepRecentRatio: 0.35, layers: true, keepToolResults: 8, summaryToolResultChars: 2000 },
  recall: {
    maxItems: 5,
    candidates: 20,
    budgetTokens: 1200,
    budgetRatio: 0.03,
    minScore: 1.0,
    /** 已漂移的条目必须有足够强的相关性才注入。 */
    driftedMinRelevance: 2.0,
    driftedWeight: 0.5,
    weights: { path: 2.0, failure: 1.5, identifier: 1.0, phrase: 1.5, confirmed: 0.5, recency: 0.1, rank: 0.3, success: 0.3, unsuccessful: 0.5 },
    effectCap: 1.0,
    changeWeight: 0.7,
    searchLimit: 8,
    /** 查询里至少有这么多个 3 字片段出现在条目中（即共享约 5 个连续汉字）才算短语命中；命中 phraseFull 个即满分。 */
    minPhraseGrams: 3,
    phraseFull: 6,
    maxQueryTerms: 40,
    excerptChars: 600,
  },
  output: { navigationChars: 16 * 1024, navigationFiles: 4000, documentChars: 24 * 1024, verificationTailLines: 200, verificationTailChars: 16 * 1024 },
  kernel: { parallelReadOnlyTools: true, maxParallelTools: 4 },
  permission: { grantPrefixWords: 3 },
  budget: { maxTokens: 5_000_000, maxToolCalls: 1000, maxWallSeconds: 7200 },
};

export type PolicySettings = typeof DEFAULT_SETTINGS;
export type RecallSettings = PolicySettings['recall'];
export type CompactionSettings = PolicySettings['compaction'];
export type BudgetSettings = PolicySettings['budget'];

/** 约 1,500 token 的经验手册上限（中文约 1 字符 ≈ 1 token 的保守估计）。 */
export const PLAYBOOK_MAX_CHARS = 1500;

/** params 只含策略包显式给出的值（决定身份）；settings 是补齐默认值后实际生效的值。 */
export type HarnessPolicy = { id: string; playbook: string; params: PolicyParams; settings: PolicySettings };

export const DEFAULT_POLICY: HarnessPolicy = createPolicy({}, '');

export function createPolicy(params: unknown, playbook: string): HarnessPolicy {
  const parsed = paramsSchema.parse(params);
  const text = playbook.trim();
  if (text.length > PLAYBOOK_MAX_CHARS) throw new Error(`经验手册超过 ${PLAYBOOK_MAX_CHARS} 字符`);
  const canonical = JSON.stringify({ params: Object.fromEntries(Object.entries(parsed).sort()), playbook: text });
  return { id: createHash('sha256').update(canonical).digest('hex').slice(0, 12), playbook: text, params: parsed, settings: resolve(parsed) };
}

export function loadPolicy(dir: string): HarnessPolicy {
  const params = JSON.parse(readFileSync(join(dir, 'params.json'), 'utf8'));
  const playbookFile = join(dir, 'playbook.md');
  return createPolicy(params, existsSync(playbookFile) ? readFileSync(playbookFile, 'utf8') : '');
}

/** 仅供评测：CODEAGENT_POLICY_DIR 指向策略包时 Runtime 以它为初始策略；无效的包在启动时直接报错。 */
export function initialPolicy(): HarnessPolicy {
  const dir = process.env.CODEAGENT_POLICY_DIR;
  return dir ? loadPolicy(dir) : DEFAULT_POLICY;
}

function resolve(params: PolicyParams): PolicySettings {
  const d = DEFAULT_SETTINGS;
  return {
    shellMaxTimeoutSec: params.shellMaxTimeoutSec ?? d.shellMaxTimeoutSec,
    repair: { ...d.repair, ...params.repair },
    compaction: { ...d.compaction, ...params.compaction },
    recall: { ...d.recall, ...params.recall, weights: { ...d.recall.weights, ...params.recall?.weights } },
    output: { ...d.output, ...params.output },
    kernel: { ...d.kernel, ...params.kernel },
    permission: { ...d.permission, ...params.permission },
    budget: { ...d.budget, ...params.budget },
  };
}
