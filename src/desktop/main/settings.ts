import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeStorage } from 'electron';
import type { KeyChange, ModelInput, ModelProfile, Preferences, ThinkingLevel } from '../../shared/contracts.js';

type StoredModel = ModelInput & { encryptedApiKey?: string };
type Settings = {
  models: StoredModel[]; activeModelId?: string; recentRoots: string[]; sandboxGrants: string[]; memoryEnabled?: boolean;
  webSearch?: WebSearchSettings; preferences?: Preferences;
};

// 完成类提醒默认只在应用内显示；需要处理与错误默认发系统通知。
export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', notify: { action: true, done: false, error: true } };

export function validatePreferences(value: unknown): Preferences {
  const input = (value ?? {}) as Partial<Preferences>;
  const notify = (input.notify ?? {}) as Partial<Preferences['notify']>;
  const flag = (name: keyof Preferences['notify']) => typeof notify[name] === 'boolean' ? notify[name] : DEFAULT_PREFERENCES.notify[name];
  return {
    theme: input.theme === 'light' || input.theme === 'dark' ? input.theme : 'system',
    notify: { action: flag('action'), done: flag('done'), error: flag('error') },
  };
}
/** 联网搜索配置；enabled 默认 false，评测环境从不开启。 */
export type WebSearchSettings = { enabled: boolean; searchUrl?: string; apiKeyHeader?: string; encryptedApiKey?: string };

const THINKING_LEVELS: readonly ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

// 旧配置里的 reasoning 恒为 false；无法识别的值一律按关闭处理，绝不把未开启的思考伪装成已开启。
function validateReasoning(value: unknown): false | ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value) ? value as ThinkingLevel : false;
}

export function validateModelInput(value: unknown): ModelInput {
  if (!value || typeof value !== 'object') throw new Error('模型配置无效');
  const input = value as Record<string, unknown>;
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const modelId = typeof input.modelId === 'string' ? input.modelId.trim() : '';
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Base URL 格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Base URL 仅支持 HTTP 或 HTTPS');
  if (!modelId) throw new Error('Model ID 不能为空');
  if (!Number.isInteger(input.contextWindow) || (input.contextWindow as number) <= 0) throw new Error('上下文预算必须为正整数');
  if (!Number.isInteger(input.maxOutputTokens) || (input.maxOutputTokens as number) <= 0) throw new Error('输出预算必须为正整数');
  if ((input.maxOutputTokens as number) >= (input.contextWindow as number)) throw new Error('输出预算必须小于上下文预算');
  const text = (name: string) => typeof input[name] === 'string' ? (input[name] as string).trim() : '';
  return {
    id: typeof input.id === 'string' && input.id ? input.id : 'default',
    name: text('name') || modelId,
    provider: text('provider'),
    api: 'openai-completions',
    baseUrl,
    modelId,
    contextWindow: input.contextWindow as number,
    maxOutputTokens: input.maxOutputTokens as number,
    reasoning: validateReasoning(input.reasoning),
    vision: input.vision === true,
  };
}

function parseStoredModel(item: unknown): StoredModel[] {
  try {
    const encryptedApiKey = (item as Record<string, unknown>).encryptedApiKey;
    return [{ ...validateModelInput(item), encryptedApiKey: typeof encryptedApiKey === 'string' ? encryptedApiKey : undefined }];
  } catch {
    return [];
  }
}

export class SettingsStore {
  private readonly file: string;
  private settings: Settings = { models: [], recentRoots: [], sandboxGrants: [] };

  constructor(userData: string) {
    this.file = join(userData, 'config', 'settings.json');
  }

  async load(): Promise<void> {
    let skipped = 0;
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      const storedModels: unknown[] = Array.isArray(value.models) ? value.models : value.model ? [value.model] : [];
      const models = storedModels.flatMap(parseStoredModel);
      skipped = storedModels.length - models.length;
      const requestedActive = typeof value.activeModelId === 'string' ? value.activeModelId : undefined;
      const rawWeb = (value.webSearch ?? {}) as Record<string, unknown>;
      this.settings = {
        models,
        activeModelId: models.some(model => model.id === requestedActive) ? requestedActive : models[0]?.id,
        // 兼容早期版本的单目录字段。
        recentRoots: Array.isArray(value.recentRoots)
          ? value.recentRoots.filter((item): item is string => typeof item === 'string')
          : typeof value.lastRootPath === 'string' ? [value.lastRootPath] : [],
        sandboxGrants: Array.isArray(value.sandboxGrants) ? value.sandboxGrants.filter((item): item is string => typeof item === 'string') : [],
        memoryEnabled: value.memoryEnabled === false ? false : undefined,
        preferences: validatePreferences(value.preferences),
        webSearch: {
          enabled: rawWeb.enabled === true,
          ...(typeof rawWeb.searchUrl === 'string' && rawWeb.searchUrl ? { searchUrl: rawWeb.searchUrl } : {}),
          ...(typeof rawWeb.apiKeyHeader === 'string' && rawWeb.apiKeyHeader ? { apiKeyHeader: rawWeb.apiKeyHeader } : {}),
          ...(typeof rawWeb.encryptedApiKey === 'string' && rawWeb.encryptedApiKey ? { encryptedApiKey: rawWeb.encryptedApiKey } : {}),
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.settings = { models: [], recentRoots: [], sandboxGrants: [] };
      // 之后的任何保存都会覆盖该文件，先留一份备份以便找回已保存的模型与密钥。
      await copyFile(this.file, `${this.file}.bak`).catch(() => undefined);
      throw new Error('配置文件损坏，已备份为 settings.json.bak，请重新保存模型配置', { cause: error });
    }
    if (skipped) {
      // 有效的模型照常加载；下次保存会丢掉无效条目，所以先备份原文件。
      await copyFile(this.file, `${this.file}.bak`).catch(() => undefined);
      throw new Error(`${skipped} 个模型配置无效已跳过，原配置已备份为 settings.json.bak`);
    }
  }

  get models(): ModelProfile[] {
    return this.settings.models.map(model => this.publicModel(model));
  }

  get model(): ModelProfile | undefined {
    const active = this.settings.models.find(model => model.id === this.settings.activeModelId) ?? this.settings.models[0];
    return active ? this.publicModel(active) : undefined;
  }

  get recentRoots(): string[] {
    return this.settings.recentRoots;
  }

  async saveModel(value: unknown, keyChange: KeyChange): Promise<ModelProfile> {
    const profile = validateModelInput(value);
    const previous = this.settings.models.find(model => model.id === profile.id);
    let encryptedApiKey = previous?.encryptedApiKey;
    if (keyChange.action === 'replace') {
      if (!keyChange.value) throw new Error('API Key 不能为空');
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('当前系统无法加密保存 API Key');
      encryptedApiKey = (await safeStorage.encryptStringAsync(keyChange.value)).toString('base64');
    } else if (keyChange.action === 'copy') {
      encryptedApiKey = this.settings.models.find(model => model.id === keyChange.fromId)?.encryptedApiKey;
      if (!encryptedApiKey) throw new Error('所选模型没有已保存的密钥');
    } else if (keyChange.action === 'remove') {
      encryptedApiKey = undefined;
    }
    const model: StoredModel = { ...profile, encryptedApiKey };
    const models = [...this.settings.models.filter(item => item.id !== profile.id), model];
    await this.persist({ ...this.settings, models, activeModelId: profile.id });
    this.settings = { ...this.settings, models, activeModelId: profile.id };
    return this.publicModel(model);
  }

  async selectModel(modelId: string): Promise<ModelProfile> {
    if (!this.settings.models.some(model => model.id === modelId)) throw new Error('模型配置不存在');
    await this.persist({ ...this.settings, activeModelId: modelId });
    this.settings = { ...this.settings, activeModelId: modelId };
    return this.model!;
  }

  async deleteModel(modelId: string): Promise<void> {
    const models = this.settings.models.filter(model => model.id !== modelId);
    if (models.length === this.settings.models.length) throw new Error('模型配置不存在');
    const activeModelId = this.settings.activeModelId === modelId ? models[0]?.id : this.settings.activeModelId;
    await this.persist({ ...this.settings, models, activeModelId });
    this.settings = { ...this.settings, models, activeModelId };
  }

  async decryptApiKey(): Promise<string | undefined> {
    const active = this.settings.models.find(model => model.id === this.settings.activeModelId) ?? this.settings.models[0];
    const encrypted = active?.encryptedApiKey;
    if (!encrypted) return undefined;
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('当前系统无法解密 API Key，请重新输入');
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result;
    } catch {
      throw new Error('API Key 解密失败，请重新输入');
    }
  }

  get memoryEnabled(): boolean {
    return this.settings.memoryEnabled !== false;
  }

  async setMemoryEnabled(enabled: boolean): Promise<void> {
    this.settings = { ...this.settings, memoryEnabled: enabled };
    await this.persist(this.settings);
  }

  // 联网搜索：默认关闭，只有保存过配置才可能开启；评测模式不读取桌面设置，天然没有联网工具。
  get webSearch(): WebSearchSettings {
    return this.settings.webSearch ?? { enabled: false };
  }

  async webSearchKey(): Promise<string | undefined> {
    return (await this.decryptStoredKey(this.settings.webSearch?.encryptedApiKey)).value;
  }

  async saveWebSearch(input: { enabled: boolean; searchUrl?: string; apiKeyHeader?: string; keyChange: KeyChange }): Promise<void> {
    const searchUrl = typeof input.searchUrl === 'string' ? input.searchUrl.trim() : '';
    const apiKeyHeader = typeof input.apiKeyHeader === 'string' ? input.apiKeyHeader.trim() : '';
    if (input.enabled) {
      if (!searchUrl) throw new Error('启用联网搜索需要先填写搜索接口地址');
      try {
        const url = new URL(searchUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        throw new Error('搜索接口地址格式无效');
      }
    }
    const previous = this.settings.webSearch;
    let encryptedApiKey = previous?.encryptedApiKey;
    if (input.keyChange.action === 'replace') {
      if (!input.keyChange.value) throw new Error('API Key 不能为空');
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('当前系统无法加密保存 API Key');
      encryptedApiKey = (await safeStorage.encryptStringAsync(input.keyChange.value)).toString('base64');
    } else if (input.keyChange.action === 'remove') {
      encryptedApiKey = undefined;
    }
    const webSearch: WebSearchSettings = {
      enabled: input.enabled,
      ...(searchUrl ? { searchUrl } : {}),
      ...(apiKeyHeader ? { apiKeyHeader } : {}),
      ...(encryptedApiKey ? { encryptedApiKey } : {}),
    };
    this.settings = { ...this.settings, webSearch };
    await this.persist(this.settings);
  }

  private async decryptStoredKey(encrypted?: string): Promise<{ value?: string; error?: string }> {
    if (!encrypted) return {};
    if (!await safeStorage.isAsyncEncryptionAvailable()) return { error: '当前系统无法解密 API Key，请重新输入' };
    try {
      return { value: (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result };
    } catch {
      return { error: 'API Key 解密失败，请重新输入' };
    }
  }

  get preferences(): Preferences {
    return this.settings.preferences ?? DEFAULT_PREFERENCES;
  }

  async savePreferences(value: unknown): Promise<Preferences> {
    const preferences = validatePreferences(value);
    this.settings = { ...this.settings, preferences };
    await this.persist(this.settings);
    return preferences;
  }

  get sandboxGrants(): string[] {
    return this.settings.sandboxGrants;
  }

  async saveRoots(recentRoots: string[], sandboxGrants: string[]): Promise<void> {
    this.settings = { ...this.settings, recentRoots, sandboxGrants };
    await this.persist(this.settings);
  }

  private publicModel(model: StoredModel): ModelProfile {
    const { encryptedApiKey: _encrypted, ...profile } = model;
    return { ...profile, hasApiKey: Boolean(model.encryptedApiKey) };
  }

  private async persist(settings: Settings): Promise<void> {
    const directory = dirname(this.file);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `settings.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
  }
}
