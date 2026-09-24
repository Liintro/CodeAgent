import { inflateRawSync } from 'node:zlib';

// 只读 ZIP（DOCX 容器）：中央目录 + stored/deflate 两种压缩方式，足够读取 OOXML 部件。
export function readZipEntries(data: Buffer, wanted: (name: string) => boolean): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(data);
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = data.readUInt16LE(offset + 10);
    const compressedSize = data.readUInt32LE(offset + 20);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (!wanted(name)) continue;
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    const raw = data.subarray(start, start + compressedSize);
    if (method === 0) entries.set(name, Buffer.from(raw));
    else if (method === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`不支持的 ZIP 压缩方式 ${method}`);
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('不是有效的 ZIP/DOCX 文件');
}
