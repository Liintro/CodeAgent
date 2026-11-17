import type { AgentMessage } from '@earendil-works/pi-agent-core';

// 中日韩文字接近每字一个 token，其余字符约 4 个一个；只按“字符数 / 4”会把中文内容低估三到四倍。
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/g;

// 图片按常见视觉模型的单张开销估算；每条消息另加角色与分隔符的开销。
const IMAGE_TOKENS = 1200;
const MESSAGE_OVERHEAD = 4;

export function tokensOf(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function messageTokens(message: AgentMessage): number {
  if (!('content' in message)) return MESSAGE_OVERHEAD + tokensOf(JSON.stringify(message));
  const content = message.content;
  if (typeof content === 'string') return MESSAGE_OVERHEAD + tokensOf(content);
  let total = MESSAGE_OVERHEAD;
  for (const block of content as { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }[]) {
    if (block.type === 'text') total += tokensOf(block.text ?? '');
    else if (block.type === 'thinking') total += tokensOf(block.thinking ?? '');
    else if (block.type === 'toolCall') total += tokensOf(`${block.name}${JSON.stringify(block.arguments ?? {})}`);
    else if (block.type === 'image') total += IMAGE_TOKENS;
    else total += tokensOf(JSON.stringify(block));
  }
  return total;
}
