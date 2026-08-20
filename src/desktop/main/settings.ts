import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { KeyChange, ModelInput, ModelProfile } from '../../shared/contracts.js';

type StoredModel = ModelInput & { encryptedApiKey?: string };
type Settings = { model?: StoredModel; lastRootPath?: string };

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
  return {
    id: typeof input.id === 'string' && input.id ? input.id : 'default',
    api: 'openai-completions',
    baseUrl,
    modelId,
    contextWindow: input.contextWindow as number,
    maxOutputTokens: input.maxOutputTokens as number,
    reasoning: false,
  };
}

export class SettingsStore {
  private readonly file: string;
  private settings: Settings = {};

  constructor(userData: string) {
    this.file = join(userData, 'config', 'settings.json');
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as Record<string, unknown>;
      this.settings = {
        model: value.model ? { ...validateModelInput(value.model), encryptedApiKey: typeof (value.model as Record<string, unknown>).encryptedApiKey === 'string' ? (value.model as Record<string, unknown>).encryptedApiKey as string : undefined } : undefined,
        lastRootPath: typeof value.lastRootPath === 'string' ? value.lastRootPath : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      this.settings = {};
      throw new Error('配置文件损坏，请重新保存模型配置', { cause: error });
    }
  }

  get model(): ModelProfile | undefined {
    return this.settings.model ? { ...this.publicModel(this.settings.model), hasApiKey: Boolean(this.settings.model.encryptedApiKey) } : undefined;
  }

  get lastRootPath(): string | undefined {
    return this.settings.lastRootPath;
  }

  async saveModel(value: unknown, keyChange: KeyChange): Promise<ModelProfile> {
    const profile = validateModelInput(value);
    let encryptedApiKey = this.settings.model?.encryptedApiKey;
    if (keyChange.action === 'replace') {
      if (!keyChange.value) throw new Error('API Key 不能为空');
      if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('当前系统无法加密保存 API Key');
      encryptedApiKey = (await safeStorage.encryptStringAsync(keyChange.value)).toString('base64');
    } else if (keyChange.action === 'remove') {
      encryptedApiKey = undefined;
    }
    const model: StoredModel = { ...profile, encryptedApiKey };
    await this.persist({ ...this.settings, model });
    this.settings = { ...this.settings, model };
    return { ...profile, hasApiKey: Boolean(encryptedApiKey) };
  }

  async decryptApiKey(): Promise<string | undefined> {
    const encrypted = this.settings.model?.encryptedApiKey;
    if (!encrypted) return undefined;
    if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('当前系统无法解密 API Key，请重新输入');
    try {
      return (await safeStorage.decryptStringAsync(Buffer.from(encrypted, 'base64'))).result;
    } catch {
      throw new Error('API Key 解密失败，请重新输入');
    }
  }

  async saveLastRoot(path?: string): Promise<void> {
    await this.persist({ ...this.settings, lastRootPath: path });
    this.settings = { ...this.settings, lastRootPath: path };
  }

  private publicModel(model: StoredModel): ModelInput {
    const { encryptedApiKey: _encrypted, ...profile } = model;
    return profile;
  }

  private async persist(settings: Settings): Promise<void> {
    const directory = join(this.file, '..');
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `settings.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, this.file);
  }
}
