'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const mode of ['window', 'tray', 'session', 'app-quit']) {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'lifecycle-electron.cjs'), mode],
        { cwd: path.join(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: 45000 });
    process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
    if (result.status !== 0) { if (result.error) console.error(result.error); process.exit(result.status || 1); }
}
