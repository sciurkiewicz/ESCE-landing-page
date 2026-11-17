import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const env = { ...process.env, PORT: '3001', COOKIE_SECURE: 'false' };
const serverArgs = ['--watch', '--env-file-if-exists=.env', 'server/index.mjs'];
const server = spawn(process.execPath, serverArgs, { stdio: 'inherit', env });
const vitePath = 'node_modules/vite/bin/vite.js';
if (!existsSync(vitePath)) {
  console.error('Brakuje zależności. Uruchom najpierw npm install.');
  server.kill();
  process.exit(1);
}
const vite = spawn(process.execPath, [vitePath], { stdio: 'inherit', env });
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill();
  vite.kill();
  process.exitCode = code;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
server.on('exit', (code) => stop(code ?? 0));
vite.on('exit', (code) => stop(code ?? 0));
server.on('error', (error) => { console.error(error.message); stop(1); });
vite.on('error', (error) => { console.error(error.message); stop(1); });
