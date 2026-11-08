const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const mode of (process.argv.includes('--real') ? ['real'] : ['normal', 'corrupt'])) {
    const result = spawnSync(require('electron'), [path.join(__dirname, 'electron-smoke.cjs'), mode], {
        cwd: path.join(__dirname, '..'), env, windowsHide: true, encoding: 'utf8', timeout: mode === 'real' ? 210000 : 110000
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.error) console.error(result.error);
    if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
