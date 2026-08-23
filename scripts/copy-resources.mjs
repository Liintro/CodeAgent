import { copyFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve('resources/generated');
await mkdir(output, { recursive: true });
await copyFile(resolve('AGENTS.md'), resolve(output, 'AGENTS.md'));
