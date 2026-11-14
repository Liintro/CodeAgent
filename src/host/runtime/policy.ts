// Harness 策略包：自改进循环唯一可以修改的产品行为。
// 一个策略包目录 = params.json（白名单参数）+ playbook.md（追加到系统提示的经验手册）+ 可选 manifest.json（谱系元数据，不参与身份）。
// 身份 policyId 只由生效内容（参数 + 手册）决定：内容相同的两个包就是同一个策略。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const paramsSchema = z.strictObject({
  /** shell 命令超时上限（秒）：模型请求更长或不设超时时按此值执行。 */
  shellMaxTimeoutSec: z.number().int().min(30).max(3600).optional(),
});

/** 约 1,500 token 的经验手册上限（中文约 1 字符 ≈ 1 token 的保守估计）。 */
export const PLAYBOOK_MAX_CHARS = 1500;

export type PolicyParams = z.infer<typeof paramsSchema>;
export type HarnessPolicy = { id: string; playbook: string; params: PolicyParams };

export const DEFAULT_POLICY: HarnessPolicy = createPolicy({}, '');

export function createPolicy(params: unknown, playbook: string): HarnessPolicy {
  const parsed = paramsSchema.parse(params);
  const text = playbook.trim();
  if (text.length > PLAYBOOK_MAX_CHARS) throw new Error(`经验手册超过 ${PLAYBOOK_MAX_CHARS} 字符`);
  const canonical = JSON.stringify({ params: Object.fromEntries(Object.entries(parsed).sort()), playbook: text });
  return { id: createHash('sha256').update(canonical).digest('hex').slice(0, 12), playbook: text, params: parsed };
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
