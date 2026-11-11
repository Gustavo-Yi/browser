'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function buildNative() {
    if (process.platform !== 'win32') throw Error('BrowserGuard requires a Windows build host.');
    const root = path.join(__dirname, '..');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const output = path.join(root, 'native', 'bin');
    fs.mkdirSync(output, { recursive: true });
    const source = path.join(root, 'native', 'BrowserGuard.cs');
    const target = path.join(output, 'YTBrowserGuard.exe');
    const manifest = path.join(output, 'build.json');
    const inputHash = hash(Buffer.concat([fs.readFileSync(source), fs.readFileSync(__filename), fs.readFileSync(compiler)]));
    try {
        const previous = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (previous.inputHash === inputHash && previous.outputHash === hash(fs.readFileSync(target))) return;
    } catch { /* Missing or stale build: compile without truncating the previous executable. */ }
    const temporary = path.join(output, 'guard-' + randomUUID() + '.exe');
    try {
        execFileSync(compiler, ['/nologo', '/target:exe', '/platform:anycpu', '/optimize+',
            '/reference:System.Management.dll', '/reference:System.Web.Extensions.dll',
            '/out:' + temporary, source], { windowsHide: true, stdio: 'inherit' });
        const outputHash = hash(fs.readFileSync(temporary));
        fs.renameSync(temporary, target);
        fs.writeFileSync(manifest, JSON.stringify({ inputHash, outputHash }, null, 2));
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
if (require.main === module) buildNative();
module.exports = { buildNative };
