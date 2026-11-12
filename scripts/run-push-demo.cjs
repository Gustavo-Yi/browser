'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.YT_UPDATE_PUSH_URL;
const child = spawn(require('electron'), [path.join(__dirname, '../test/push-electron.cjs'), 'demo'], {
    cwd: path.join(__dirname, '..'), env, stdio: 'inherit', windowsHide: true
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code || 0; });
