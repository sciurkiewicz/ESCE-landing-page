import { createServer } from 'node:http';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a port number between 1 and 65535.');
}

const app = createApp();
const server = createServer(app);
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(port, host, () => {
  console.log(`ESCE: http://${host}:${port}`);
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
    console.warn('Panel autora jest wyłączony. Ustaw ADMIN_PASSWORD (minimum 12 znaków) w .env.');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => { app.close(); process.exit(0); });
    server.closeIdleConnections();
  });
}
