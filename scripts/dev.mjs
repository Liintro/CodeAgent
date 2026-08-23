import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const env = { ...process.env, VITE_DEV_SERVER_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const server = await createServer({ configFile: resolve('vite.config.ts') });
await server.listen();
const child = spawn(require('electron'), [resolve('build/dist/desktop/main/index.js')], {
  env,
  stdio: 'inherit',
});
child.on('exit', async code => {
  await server.close();
  process.exit(code ?? 1);
});
