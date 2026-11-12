'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createPushService } = require('./server.cjs');
const dataDir = path.resolve(process.env.YT_PUSH_DATA_DIR || path.join(__dirname, '../.local/push-service'));
const host = process.env.YT_PUSH_HOST || '127.0.0.1';
const port = Number(process.env.YT_PUSH_PORT || 47321);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid YT_PUSH_PORT');
fs.mkdirSync(dataDir, { recursive: true });
let token = process.env.YT_PUSH_TOKEN;
if (!token) {
    if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw Error('Non-loopback binding requires an explicit YT_PUSH_TOKEN and a TLS reverse proxy');
    const tokenFile = path.join(dataDir, 'publish-token');
    try { fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    token = fs.readFileSync(tokenFile, 'utf8').trim();
}
const service = createPushService({ dataDir, token });
service.server.listen(port, host, () => console.log(`Push service listening on ${host}:${port}\nState directory: ${dataDir}\nNo release is published on startup.`));
service.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void service.close().then(() => process.exit(0)); });
