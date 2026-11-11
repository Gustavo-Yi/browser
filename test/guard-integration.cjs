'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { fork, spawn, execFileSync } = require('node:child_process');
const { AccountManager, findChromePath } = require('../lib/account-manager');
const windows = require('../lib/windows-processes');
const { BrowserGuard } = require('../lib/browser-guard');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-guard-regression-'));
const results = [];
async function until(check) {
    for (let i = 0; i < 30; i++) { if (await check()) return; await pause(300); }
    throw Error('Timed out waiting for process cleanup');
}
let owner, outside;
function allProfileProcesses(directory) {
    const encoded = Buffer.from(directory).toString('base64');
    const script = `$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $rows=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object ProcessId,ParentProcessId); ConvertTo-Json -InputObject $rows -Compress`;
    return JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim());
}
(async () => {
    // An unmanaged browser fixture must survive every YT cleanup, including crash.
    const otherRoot = path.join(root, 'ordinary', 'profiles'); fs.mkdirSync(otherRoot, { recursive: true });
    const profile = path.join(otherRoot, 'unrelated');
    const chrome = findChromePath({}); assert(chrome);
    outside = spawn(chrome, ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check',
        '--disable-background-mode', '--window-position=-32000,-32000', '--disable-sync', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    await until(async () => (await windows.listProcesses(otherRoot)).length === 1);
    for (const mode of ['normal', 'force', 'crash']) {
        const dir = path.join(root, 'yt-guard-regression-' + mode); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(Array.from({ length: 3 }, (_, i) => ({ id: 'env-' + i, name: 'Isolated ' + i }))));
        owner = fork(path.join(__dirname, 'guard-owner.cjs'), [dir], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
        let diagnostics = ''; owner.stderr.on('data', data => { diagnostics += data; });
        const exited = new Promise(resolve => owner.once('exit', resolve));
        const message = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('Owner readiness timeout ' + diagnostics)), 90000);
            owner.once('message', message => { clearTimeout(timer); message.error ? reject(Error(message.error)) : resolve(message); });
            owner.once('error', reject);
        });
        assert.equal(message.pids.length, 3);
        const before = allProfileProcesses(path.join(dir, 'profiles'));
        assert(before.length > 3, 'Must observe real Chrome child processes, not only browser roots');
        if (mode === 'crash') owner.kill(); else owner.send(mode);
        await exited;
        await until(async () => (await windows.listProcesses(path.join(dir, 'profiles'))).length === 0);
        await until(() => allProfileProcesses(path.join(dir, 'profiles')).length === 0);
        assert.equal((await windows.listProcesses(otherRoot)).length, 1, 'Unrelated Chrome must survive');
        results.push(mode + ': all 3 environments and ' + before.length + ' profile processes gone, unrelated Chrome survived');
        console.log('PASS ' + results.at(-1));
    }
    // Old-version orphan takeover uses identity validation and is then force-cleanable.
    const dir = path.join(root, 'yt-guard-regression-adopt'); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([{ id: 'legacy', name: 'Legacy fixture' }]));
    const legacy = spawn(chrome, ['--user-data-dir=' + path.join(dir, 'profiles', 'legacy'), '--no-first-run', '--no-default-browser-check',
        '--disable-background-mode', '--window-position=-32000,-32000', 'about:blank'], { stdio: 'ignore', windowsHide: true });
    legacy.on('error', () => {});
    await until(async () => (await windows.listProcesses(path.join(dir, 'profiles'))).length === 1);
    const record = (await windows.listProcesses(path.join(dir, 'profiles')))[0];
    const mismatch = new BrowserGuard();
    await assert.rejects(mismatch.adopt({ ...record, createdAt: 'wrong-identity' }));
    assert.equal((await windows.listProcesses(path.join(dir, 'profiles'))).length, 1);
    const manager = new AccountManager({ userData: dir });
    await manager.refresh(); assert.equal(manager.getRunningCount(), 1);
    manager.beginShutdown(); await manager.forceCloseAllProfiles();
    assert.equal((await windows.listProcesses(path.join(dir, 'profiles'))).length, 0);
    results.push('legacy takeover / PID identity guard / forced exit');
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ passed: true, results, root }, null, 2));
    console.log(JSON.stringify({ passed: true, results, root }));
})().catch(error => { console.error(error.stack, root); process.exitCode = 1; }).finally(async () => {
    if (owner?.exitCode === null) owner.kill();
    for (const record of await windows.listProcesses(path.join(root, 'ordinary', 'profiles'))) await windows.requestClose(record);
    // No wildcard taskkill. Parent exit also releases every managed job from this test.
    setTimeout(() => process.exit(process.exitCode || 0), 1000);
});
