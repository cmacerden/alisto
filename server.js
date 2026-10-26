require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { createApp } = require('./lib/app');
const { acquireInstanceLock } = require('./lib/instance-lock');

const production = process.env.NODE_ENV === 'production';
const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data/alisto.sqlite'));
let sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret && !production) {
  const secretPath = path.join(path.dirname(databasePath), 'session-secret');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  try { fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  sessionSecret = fs.readFileSync(secretPath, 'utf8').trim();
}

const releaseLock = acquireInstanceLock(databasePath);
const runtime = createApp({
  databasePath, sessionSecret, production, trustProxy: process.env.TRUST_PROXY === '1'
});
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
const server = http.createServer(runtime.app);
runtime.attach(server);
server.listen(port, () => console.log(`Alisto · Meet extension backend: http://localhost:${port}`));
server.on('error', error => { console.error(error.message); runtime.close(); releaseLock(); process.exitCode = 1; });

function shutdown() {
  runtime.stopRealtime();
  server.close(() => { runtime.close(); releaseLock(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
