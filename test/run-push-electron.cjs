'use strict';
const { spawnSync } = require('node:child_process'), path = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.YT_UPDATE_PUSH_URL;
for (const mode of ['push', 'manual', 'checksum']) {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'push-electron.cjs'), mode], {
        cwd: path.join(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 75_000
    });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.status !== 0) { if (result.error) console.error(result.error); process.exit(result.status || 1); }
}
