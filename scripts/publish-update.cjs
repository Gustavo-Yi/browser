'use strict';
const fs = require('node:fs'), path = require('node:path');
const { validVersion, safePushURL } = require('../lib/update-protocol');
async function main() {
    const version = process.argv[2];
    if (!validVersion(version)) throw Error('Usage: npm run push:publish -- 2.2.16 (only AFTER release artifacts are available)');
    const base = safePushURL(process.env.YT_PUSH_URL || 'http://127.0.0.1:47321');
    const dataDir = path.resolve(process.env.YT_PUSH_DATA_DIR || path.join(__dirname, '../.local/push-service'));
    const token = process.env.YT_PUSH_TOKEN || fs.readFileSync(path.join(dataDir, 'publish-token'), 'utf8').trim();
    const response = await fetch(new URL('/publish', base), { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(15_000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `Publish failed: ${response.status}`);
    console.log(JSON.stringify(result, null, 2));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
