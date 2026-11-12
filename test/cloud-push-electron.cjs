'use strict';
const { app, net } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-cloud-push-'));
app.setPath('userData', root); app.setPath('sessionData', root);
const { verify } = require('./cloud-push-smoke.cjs');
const timeout = setTimeout(() => { console.error('Cloud push test timeout'); app.exit(2); }, 90_000);
app.whenReady().then(async () => {
    const result = await verify(process.env.YT_PUSH_URL, process.argv[2], process.env.YT_PUSH_TOKEN, { fetch: net.fetch, WebSocket: net.WebSocket });
    result.transport = 'Electron net.WebSocket / Chromium system proxy';
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, root }, null, 2)); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
