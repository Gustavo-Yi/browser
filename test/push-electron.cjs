'use strict';
// Real main/preload/React + real SSE + real electron-updater download/SHA512.
// Only process inventory and the final installer handoff are fixtures. NEVER
// execute the downloaded non-executable test bytes or touch installed user data.
const electron = require('electron');
const { app, BrowserWindow, nativeTheme } = electron;
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto'), Module = require('node:module');
const assert = require('node:assert/strict');
const { createPushService } = require('../push-service/server.cjs');
const { AccountManager } = require('../lib/account-manager');
const { NsisUpdater } = require('electron-updater');
const mode = process.argv[2] || 'push';
const demo = mode === 'demo';
const currentVersion = require('../package.json').version;
const parts = currentVersion.split('.').map(Number); parts[2]++;
const targetVersion = parts.join('.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-electron-' + mode + '-'));
for (const dir of ['userData', 'appData', 'cache']) fs.mkdirSync(path.join(root, dir));
const userData = path.join(root, 'userData');
app.setPath('userData', userData); app.setPath('sessionData', userData); app.setPath('appData', path.join(root, 'appData'));
app.getVersion = () => require('../package.json').version;
app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('disable-background-networking');
nativeTheme.themeSource = 'light';
const accounts = [{ id: '10001', name: '推送测试环境 01' }, { id: '10002', name: '推送测试环境 02' }];
const accountsBytes = JSON.stringify(accounts);
fs.writeFileSync(path.join(userData, 'accounts.json'), accountsBytes);
for (const account of accounts) {
    const profile = path.join(userData, 'profiles', account.id, 'Default'); fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'Cookies'), 'unchanged isolated login fixture');
}
let records = accounts.map((a, i) => ({ pid: 990001 + i, profile: path.join(userData, 'profiles', a.id) }));
let win, manager, closeFails = false, installFails = false, installs = 0, visible = true;
let checksCount = 0, fileRequests = 0, metadataRequests = 0, corrupt = mode === 'checksum';
let service, feed, updater;
const checks = [], errors = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 20_000;
    while (Date.now() < end) { if (await fn()) return; await pause(25); }
    throw Error('Push Electron timeout');
}
function check(name, value) { assert(value, name); checks.push(name); }
const evaluate = script => win.webContents.executeJavaScript(script);
async function click(selector) {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) win.webContents.sendInputEvent({ type, ...point, button: 'left', clickCount: 1 });
    await pause(100);
}
async function closeDialog() {
    if (await evaluate('!!document.querySelector("dialog[open]")')) {
        await click('[aria-label="关闭弹窗"]'); await until(() => evaluate('!document.querySelector("dialog")'));
    }
}
async function screenshot(name) { await pause(150); fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG()); }
const timeout = demo ? null : setTimeout(() => { console.error('Push test watchdog', root); app.exit(2); }, 60_000);

async function main() {
    const token = crypto.randomBytes(32).toString('hex');
    service = createPushService({ dataDir: path.join(root, 'server'), token, heartbeatMs: 50 });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const pushBase = `http://127.0.0.1:${service.server.address().port}`;
    if (demo) fs.writeFileSync(path.join(root, 'server', 'publish-token'), token, { mode: 0o600 });
    process.env.YT_UPDATE_PUSH_URL = pushBase + '/events';
    const payload = Buffer.alloc(512 * 1024, 65); Buffer.from('NONEXECUTABLE LOCAL UPDATE TEST\n').copy(payload);
    const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
    feed = http.createServer((req, res) => {
        if (req.url.split('?')[0] === '/latest.yml') {
            metadataRequests++;
            res.writeHead(200, { 'Content-Type': 'application/yaml' });
            return res.end(JSON.stringify({ version: targetVersion, files: [{ url: 'fixture.exe', sha512, size: payload.length }],
                path: 'fixture.exe', sha512, releaseDate: new Date().toISOString() }));
        }
        if (req.url.split('?')[0] !== '/fixture.exe') { res.writeHead(404); return res.end(); }
        fileRequests++;
        const bytes = Buffer.from(payload); if (corrupt) bytes[100] ^= 1;
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
        let offset = 0;
        const timer = setInterval(() => {
            res.write(bytes.subarray(offset, offset + 32768)); offset += 32768;
            if (offset >= bytes.length) { clearInterval(timer); res.end(); }
        }, 65);
        res.on('close', () => clearInterval(timer));
    });
    await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
    const configPath = path.join(root, 'test-app-update.yml');
    fs.writeFileSync(configPath, JSON.stringify({ provider: 'generic', url: `http://127.0.0.1:${feed.address().port}`,
        updaterCacheDirName: 'isolated-update-cache' }));
    updater = new NsisUpdater(); updater.forceDevUpdateConfig = true; updater.updateConfigPath = configPath;
    updater.disableDifferentialDownload = true; updater.disableWebInstaller = true;
    Object.defineProperty(updater.app, 'baseCachePath', { get: () => path.join(root, 'cache') });
    const originalCheck = updater.checkForUpdates.bind(updater);
    updater.checkForUpdates = () => { checksCount++; return originalCheck(); };
    updater.quitAndInstall = (silent, restart) => {
        assert.equal(records.length, 0, 'All environments close before installer');
        assert.equal(silent, true); assert.equal(restart, true);
        if (installFails) { updater.emit('error', Error('fixture installer startup failed')); return; }
        installs++;
        if (demo) {
            console.log('本地演示完成：已收到完成更新操作；测试不会执行安装包。');
            setImmediate(() => { void cleanup().then(() => app.exit(0)); });
        }
    };
    const appProxy = new Proxy(app, { get(target, key) {
        if (key === 'isPackaged') return true;
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const load = Module._load;
    Module._load = function(request, parent, ...rest) {
        if (parent?.filename === path.join(__dirname, '..', 'main.js')) {
            if (request === 'electron-updater') return { autoUpdater: updater };
            if (request === 'electron') return { ...electron, app: appProxy,
                BrowserWindow: function(options) {
                    win = new BrowserWindow({ ...options, width: 1200, height: 820, show: demo,
                        webPreferences: { ...options.webPreferences, offscreen: !demo, backgroundThrottling: false } });
                    win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
                    if (demo) {
                        win.on('page-title-updated', event => event.preventDefault());
                        win.webContents.on('did-finish-load', () => win.setTitle('YT 本地推送演示 · 独立数据 · 不执行安装'));
                    } else {
                        win.show = () => { visible = true; }; win.hide = () => { visible = false; };
                        win.focus = () => {}; win.setAlwaysOnTop = () => {};
                    }
                    return win;
                },
                dialog: demo ? electron.dialog : { showMessageBox: async () => ({ response: 0 }), showErrorBox: (_title, message) => { throw Error(message); } }
            };
            if (request === './lib/account-manager') return { AccountManager: class extends AccountManager {
                constructor(options) {
                    super({ ...options, guard: null, pollDelay: 1, closeTimeout: 20,
                        processes: { listProcesses: async () => [...records], requestClose: async record => {
                            if (closeFails) throw Error('fixture close denied'); records = records.filter(row => row !== record);
                        } }
                    }); manager = this;
                }
            } };
        }
        return load.call(this, request, parent, ...rest);
    };
    require('../main.js');
    await until(async () => win && !win.webContents.isLoading() && service.clientCount === 1 &&
        await evaluate('document.querySelectorAll(".account-row.running").length===2').catch(() => false));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    await pause(300);
    check('startup and heartbeats never query update metadata', checksCount === 0 && metadataRequests === 0);
    if (demo) {
        console.log('\n本地推送演示已连接。未发布前不会下载。请另开 PowerShell，执行：\n' +
            `Set-Location -LiteralPath '${path.join(__dirname, '..')}'\n` +
            `$env:YT_PUSH_URL='${pushBase}'\n` +
            `$env:YT_PUSH_DATA_DIR='${path.join(root, 'server')}'\n` +
            `npm run push:publish -- ${targetVersion}\n\n` +
            '手动检查按钮也可以直接触发同一下载流程。测试包为无执行能力的占位数据，完成更新只验证操作后退出演示。');
        return;
    }
    if (mode === 'manual') {
        await service.close(); service = null;
        await click('#nav-update-btn'); await click('dialog .button.primary');
    } else {
        win.close(); await until(() => !visible);
        check('tray client remains alive without closing environments', records.length === 2);
        const response = await fetch(pushBase + '/publish', { method: 'POST', headers: {
            'Content-Type': 'application/json', Authorization: 'Bearer ' + token
        }, body: JSON.stringify({ version: targetVersion }) });
        assert.equal(response.status, 201);
    }
    await until(() => fileRequests === 1);
    check('release/manual trigger starts real updater download once', checksCount === 1 && metadataRequests === 1 && fileRequests === 1);
    check('background download does not close environments or install', records.length === 2 && installs === 0);
    if (mode !== 'manual') check('push download opens no dialog and shows no premature completion button', await evaluate('!document.querySelector("dialog") && !document.querySelector("#finish-update-btn")'));
    await evaluate('window.electronAPI.checkUpdate()');
    check('manual click during push/manual download does not duplicate it', checksCount === 1 && fileRequests === 1);
    if (mode === 'checksum') {
        await until(() => evaluate('window.electronAPI.getUpdateState().then(r=>r.update.type==="error")'));
        check('real SHA512 mismatch is rejected and never marked ready', !updater.installerPath && installs === 0 && await evaluate('!document.querySelector("#finish-update-btn")'));
        corrupt = false; app.emit('second-instance');
        await click('#nav-update-btn'); await click('dialog .button.primary');
    }
    await until(() => evaluate('window.electronAPI.getUpdateState().then(r=>r.update.type==="ready")'));
    app.emit('second-instance'); await closeDialog();
    await until(() => evaluate('!!document.querySelector("#finish-update-btn")'));
    check('real downloaded file passes expected SHA512', crypto.createHash('sha512').update(fs.readFileSync(updater.installerPath)).digest('base64') === sha512);
    check('download ready never installs automatically or on ordinary quit', installs === 0 && updater.autoInstallOnAppQuit === false);
    await screenshot('ready-light');
    await click('[data-open-appearance]'); await click('dialog [data-mode="dark"]'); await closeDialog();
    await screenshot('ready-dark');
    win.setContentSize(920, 680); await pause(100);
    check('completion card fits minimum window', await evaluate('(()=>{const r=document.querySelector(".update-notice").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&document.documentElement.scrollWidth<=innerWidth})()'));
    await screenshot('ready-920');
    win.webContents.reload();
    await until(() => evaluate('!!document.querySelector("#finish-update-btn")').catch(() => false));
    check('renderer reload restores ready snapshot without re-download', checksCount === (mode === 'checksum' ? 2 : 1));
    const before = checksCount;
    const status = await evaluate('window.electronAPI.checkUpdate()');
    check('manual check after READY returns existing download', status.update.type === 'ready' && checksCount === before);
    closeFails = true;
    await click('#finish-update-btn');
    await until(() => evaluate('!!document.querySelector(".toast.error") && !document.querySelector("#finish-update-btn").disabled'));
    check('graceful close failure blocks install and preserves running environments', installs === 0 && records.length === 2 && !manager.shuttingDown);
    closeFails = false; installFails = true;
    await click('#finish-update-btn');
    await until(() => evaluate('document.querySelector(".toast-stack").textContent.includes("fixture installer startup failed")'));
    check('inline installer error unlocks lifecycle for retry', records.length === 0 && installs === 0 && !manager.shuttingDown);
    installFails = false;
    await until(() => evaluate('!document.querySelector("#finish-update-btn").disabled'));
    await click('#finish-update-btn'); await until(() => installs === 1);
    check('completion button hands off silent install with relaunch after all environments exit', records.length === 0 && installs === 1);
    check('accounts and login fixture bytes remain unchanged', fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8') === accountsBytes &&
        accounts.every(a => fs.readFileSync(path.join(userData, 'profiles', a.id, 'Default', 'Cookies'), 'utf8') === 'unchanged isolated login fixture'));
    check('no renderer errors', errors.length === 0);
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ passed: true, mode, checks, root, metadataRequests, fileRequests,
        note: 'Real SSE and updater download/hash verification; final installer deliberately intercepted, non-executable fixture.' }, null, 2));
    console.log(JSON.stringify({ passed: true, mode, checks: checks.length, root }));
    await cleanup(); app.exit(0);
}
async function cleanup() {
    clearTimeout(timeout);
    if (win && !win.isDestroyed()) win.destroy();
    if (service) { await service.close(); service = null; }
    if (feed) await new Promise(resolve => feed.close(resolve));
}
main().catch(async error => {
    console.error(error.stack, root);
    fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
    try { await cleanup(); } catch { /* preserve original failure */ }
    app.exit(1);
});
