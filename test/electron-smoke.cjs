'use strict';
const electron = require('electron');
const { app, BrowserWindow, nativeTheme } = electron;
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { AccountManager } = require('../lib/account-manager');
const { BrowserGuard } = require('../lib/browser-guard');
const repo = process.env.YT_TEST_APP_ROOT || path.join(__dirname, '..');
const mode = process.argv[2] || 'normal';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-electron-' + mode + '-'));
const userData = path.join(root, 'userData');
const appData = path.join(root, 'appData');
fs.mkdirSync(userData); fs.mkdirSync(appData);
app.setPath('userData', userData); app.setPath('appData', appData); app.setPath('sessionData', userData);
app.getVersion = () => require('../package.json').version;
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');
const accountsFile = path.join(userData, 'accounts.json');
const initial = JSON.stringify([{ id: '10001', name: '原有环境', lastUsed: '' }, ...(mode === 'real' ? [{ id: '20002', name: '独立环境 02', lastUsed: '' }] : [])]);
fs.writeFileSync(accountsFile, mode === 'corrupt' ? 'BROKEN JSON' : initial);
if (mode === 'corrupt') fs.writeFileSync(accountsFile + '.bak', initial);
const profile = path.join(userData, 'profiles', '10001', 'Default');
fs.mkdirSync(profile, { recursive: true });
if (mode !== 'real') {
    fs.writeFileSync(path.join(profile, 'Preferences'), '{"existing":true');
    fs.writeFileSync(path.join(profile, 'Cookies'), 'fixture login marker');
}
let win, manager, installed = 0, closeFails = false, listFails = false;
const openedPaths = [], errors = [];
nativeTheme.themeSource = 'light';
let records = [];
const updater = new EventEmitter();
updater.downloadUpdate = async () => {};
updater.checkForUpdates = async () => { throw Error('Network disabled in smoke test'); };
updater.quitAndInstall = () => { installed++; };
const load = Module._load;
Module._load = function (request, parent, ...args) {
    if (parent?.filename === path.join(repo, 'main.js')) {
        if (request === 'electron') return {
            ...electron,
            BrowserWindow: function (options) {
                win = new BrowserWindow({ ...options, width: 1440, height: 960, show: false, webPreferences: { ...options.webPreferences, backgroundThrottling: false, offscreen: true } });
                win.setContentSize(1440, 960);
                win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
                win.webContents.on('render-process-gone', (_e, details) => errors.push(JSON.stringify(details)));
                win.show = () => {}; win.focus = () => {}; win.setAlwaysOnTop = () => {};
                return win;
            },
            dialog: { showErrorBox: (...x) => { throw Error(x.join(' ')); }, showMessageBox: async () => ({ response: 2 }), showOpenDialog: async () => ({ canceled: true }) },
            shell: { openPath: async p => { openedPaths.push(p); return ''; }, openExternal: async () => {} }
        };
        if (request === 'electron-updater') return { autoUpdater: updater };
        if (request === './lib/account-manager') return {
            AccountManager: class extends AccountManager {
                constructor(options) {
                    if (mode === 'real') {
                        const guard = new BrowserGuard(); const guardedSpawn = guard.spawn.bind(guard);
                        guard.spawn = (exe, args) => guardedSpawn(exe, [...args.filter(x => x !== '--start-maximized'),
                            '--window-position=-32000,-32000', '--window-size=800,600', '--start-minimized',
                            '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank']);
                        super({ ...options, focus: () => {}, launchTimeout: 20000, closeTimeout: 15000, guard }); manager = this; return;
                    }
                    super({ ...options, pollDelay: 1, launchTimeout: 100, closeTimeout: 20,
                        findChrome: () => 'C:\\fixture\\chrome.exe',
                        processes: {
                            listProcesses: async () => { if (listFails) throw Error('fixture inventory failure'); return [...records]; },
                            requestClose: async record => {
                                if (closeFails) throw Error('fixture access denied');
                                records = records.filter(x => x !== record);
                            }
                        },
                        spawnProcess: (_exe, args) => {
                            const child = new EventEmitter(); child.pid = 100000 + records.length; child.unref = () => {};
                            setImmediate(() => {
                                records.push({ pid: child.pid, executable: 'C:\\fixture\\chrome.exe', createdAt: 'test', profile: args[0].slice(16) });
                                child.emit('spawn');
                            });
                            return child;
                        }
                    }); manager = this;
                }
            }
        };
    }
    return load.call(this, request, parent, ...args);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + (mode === 'real' ? 45000 : 15000);
    while (Date.now() < end) { if (await check()) return; await pause(30); }
    throw Error('Smoke test timeout');
}
const evaluate = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(error.message + '\nExpression: ' + code); });
const timeout = setTimeout(() => { console.error('Electron smoke watchdog', root); app.exit(2); }, mode === 'real' ? 180000 : 90000);
require(path.join(repo, 'main.js'));
const checks = [];
function check(name, value) { assert(value, name); checks.push(name); }
async function click(selector) {
    const point = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`);
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await pause(100);
}
async function fill(selector, value) {
    await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(String(value))});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await pause(60);
}
async function shot(name) {
    await pause(400); await win.webContents.capturePage(); await pause(100);
    fs.writeFileSync(path.join(root, name + '.png'), (await win.webContents.capturePage()).toPNG());
}
async function closeDialog() { if (await evaluate('!!document.querySelector("dialog[open]")')) { await click('[aria-label="关闭弹窗"]'); await until(() => evaluate('!document.querySelector("dialog[open]")')); } }
app.whenReady().then(async () => {
    await until(async () => win && !win.webContents.isLoading() && await evaluate(`document.querySelectorAll(".account-row").length === ${mode === 'real' ? 2 : 1}`).catch(() => false));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const security = await evaluate('({requireType:typeof require,processType:typeof process,rawIPC:typeof window.electronAPI.send})');
    assert.deepEqual(security, { requireType: 'undefined', processType: 'undefined', rawIPC: 'undefined' });
    const prefs = win.webContents.getLastWebPreferences();
    check('sandbox, contextIsolation, no nodeIntegration', !prefs.nodeIntegration && prefs.contextIsolation && prefs.sandbox);
    check('startup preserves account bytes', fs.readFileSync(accountsFile, 'utf8') === (mode === 'corrupt' ? 'BROKEN JSON' : initial));
    if (mode === 'real') {
        await until(() => evaluate('!document.getElementById("launch-all-btn").disabled'));
        await click('#launch-all-btn');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===2 && !document.getElementById("close-all-btn").disabled'));
        const listProcesses = require('../lib/windows-processes').listProcesses;
        let actual = await listProcesses(manager.profilesRoot);
        check('real UI batch starts two real Chrome processes', actual.length === 2 && new Set(actual.map(x => x.profile)).size === 2);
        const survivor = actual.find(x => x.profile.endsWith('20002'));
        await click('[data-account="10001"] [data-action="toggle"]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===1 && !document.getElementById("launch-all-btn").disabled'));
        actual = await listProcesses(manager.profilesRoot);
        check('real UI single close keeps other Chrome PID and identity', actual.length === 1 && actual[0].pid === survivor.pid && actual[0].createdAt === survivor.createdAt);
        await shot('real-chrome-dashboard');
        await click('[data-account="10001"] [data-action="toggle"]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===2 && !document.getElementById("close-all-btn").disabled'));
        check('real UI reopens same profile IDs', manager.accounts.map(x => x.id).join(',') === '10001,20002');
        await click('#close-all-btn'); await click('[data-confirm]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===0 && !document.querySelector("dialog")'));
        check('real UI close-all leaves no fixture Chrome processes', (await listProcesses(manager.profilesRoot)).length === 0);
    } else if (mode === 'corrupt') {
        check('corrupt account write rejected', !(await evaluate('window.electronAPI.addAccount({name:"不得写入"})')).ok);
        check('corrupt primary and backup untouched', fs.readFileSync(accountsFile, 'utf8') === 'BROKEN JSON' && fs.readFileSync(accountsFile + '.bak', 'utf8') === initial);
        check('corrupt warning visible and creation disabled', await evaluate('!document.getElementById("storage-warning").hidden && document.getElementById("add-account-btn").disabled'));
        await click('[data-open-appearance]');
        await click('dialog [data-mode="dark"]');
        check('appearance still usable in read-only mode', await evaluate('document.documentElement.dataset.theme==="dark"'));
        await closeDialog();
    } else {
        await until(() => evaluate('!document.getElementById("add-account-btn").disabled'));
        await click('#add-account-btn');
        const payload = '"><img src=x onerror="window.auditInjected=true">';
        await fill('#environment-name', payload); await click('#account-form button[type="submit"]');
        await until(() => evaluate('document.querySelectorAll(".account-row").length===2 && !document.querySelector("dialog")'));
        check('create via UI persists through real IPC/store', manager.accounts.length === 2 && manager.accounts[1].name === payload);
        check('name injection rendered as text', await evaluate('document.querySelectorAll(".account-row img").length===0 && window.auditInjected!==true'));
        await evaluate(`window.electronAPI.updateAccount({id:${JSON.stringify(manager.accounts[1].id)},name:'WhatsApp 业务02'})`);
        await click('#bulk-account-btn'); await fill('#environment-name', '批量测试'); await fill('#environment-count', 2); await click('#bulk-form button[type="submit"]');
        await until(() => evaluate('document.querySelectorAll(".account-row").length===4 && !document.querySelector("dialog")'));
        check('bulk create through UI', manager.accounts.length === 4 && manager.accounts[2].name === '批量测试-01');
        await click('[data-account="10001"] .edit-button'); await fill('#environment-name', '原环境改名'); await click('#account-form button[type="submit"]');
        await until(() => evaluate('!document.querySelector("dialog")'));
        check('rename retains original ID and metadata', manager.accounts[0].id === '10001' && manager.accounts[0].name === '原环境改名');
        check('unexpected fields rejected', !(await evaluate('window.electronAPI.updateAccount({id:"10001",name:"bad",lastUsed:"inject"})')).ok);
        check('path traversal rejected', !(await evaluate('window.electronAPI.openProfileFolder("../outside")')).ok && !(await evaluate('window.electronAPI.closeProfile("../outside")')).ok);
        await fill('#profile-search', '原环境改名'); check('search filters real names', await evaluate('document.querySelectorAll(".account-row").length===1'));
        await fill('#profile-search', '');
        await click('[data-account="10001"] [data-action="toggle"]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===1 && !document.getElementById("launch-all-btn").disabled'));
        check('single launch UI reaches manager state', manager.getRunningCount() === 1);
        check('running deletion rejected', !(await evaluate('window.electronAPI.deleteAccount("10001")')).ok);
        await click('#launch-all-btn');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===4 && !document.getElementById("close-all-btn").disabled'));
        check('batch UI launches all distinct environments', manager.getRunningCount() === 4 && new Set(records.map(x => x.profile)).size === 4);
        closeFails = true;
        await click('[data-account="10001"] [data-action="toggle"]');
        await until(() => evaluate('!document.getElementById("close-all-btn").disabled'));
        check('failed single close remains running, error shown', manager.getRunningCount() === 4 && await evaluate('document.querySelector(".toast.error")?.textContent.includes("未退出")'));
        await click('#nav-update-btn');
        check('idle update dialog has no explanatory or connection copy and retains manual check', await evaluate('!document.querySelector("dialog [role=status]") && !document.querySelector("[data-push-status]") && document.querySelector("dialog .button.primary").textContent === "检查更新"'));
        await shot('update-idle');
        await click('dialog .button.primary');
        check('development update does not install or download', installed === 0 && updater.autoInstallOnAppQuit === false && await evaluate('document.querySelector("dialog").textContent.includes("不检查线上更新")'));
        await closeDialog();
        updater.emit('update-downloaded', { version: '2.2.16' });
        check('update install blocked on graceful-close failure', !(await evaluate('window.electronAPI.restartUpdate()')).ok && installed === 0);
        closeFails = false;
        await click('[data-account="10001"] [data-action="toggle"]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===3 && !document.getElementById("launch-all-btn").disabled'));
        check('single close leaves other environments running', !manager.activeProcesses.has('10001') && manager.getRunningCount() === 3);
        await click('#close-all-btn'); await click('[data-confirm]');
        await until(() => evaluate('document.querySelectorAll(".account-row.running").length===0 && !document.querySelector("dialog")'));
        check('close all UI reaches authoritative empty process inventory', records.length === 0);
        listFails = true; await manager.refresh().catch(() => {}); await pause(100);
        check('uncertain process status disables launch, shows warning', await evaluate('document.getElementById("launch-all-btn").disabled && !document.getElementById("storage-warning").hidden && document.querySelector(".status").textContent.includes("待确认")'));
        listFails = false; await manager.refresh(); await pause(100);
        await click('[data-account="10001"] [title="打开数据目录"]'); await click('#open-root-folder-btn');
        check('folder actions resolve only fixture root', openedPaths.length === 2 && openedPaths[0] === manager.getProfilePath('10001') && openedPaths[1] === manager.profilesRoot);
        // Persisted accounts and all profile bytes must remain unchanged throughout appearance work.
        const beforeAppearance = fs.readFileSync(accountsFile, 'utf8');
        updater.emit('update-not-available');
        await click('[data-open-appearance]');
        check('red-box explanation copy removed', await evaluate(`!['黑白两种底色','明亮的白色界面','柔和的黑色界面','随系统自动切换','按钮 · 选中态','文字自动适配对比度','外观设置已记住','独立交互预览','独立数据目录 · 登录状态保留','当前仅演示','重置演示','模拟账号'].some(x=>document.body.innerText.includes(x))`));
        await click('dialog [data-mode="dark"]'); await click('[data-preset="#8b5cf6"]');
        check('dark mode and preset change real accent', await evaluate('document.documentElement.dataset.theme==="dark" && document.documentElement.style.getPropertyValue("--accent-fill")==="#8b5cf6"'));
        await shot('appearance-dark');
        await fill('#rgb-0-number', 255); await fill('#rgb-1-number', 120); await fill('#rgb-2-number', 20);
        check('RGB numbers immediately apply exact RGB', await evaluate('document.documentElement.style.getPropertyValue("--accent-fill")==="#ff7814"'));
        await fill('#rgb-0-number', 999); check('invalid RGB does not change theme and exposes validation', await evaluate('!!document.querySelector("#rgb-error") && document.documentElement.style.getPropertyValue("--accent-fill")==="#ff7814"'));
        await click('.restore-appearance');
        nativeTheme.themeSource = 'dark'; await pause(200);
        check('system mode tracks OS dark mode', await evaluate('document.documentElement.dataset.themeMode==="system" && document.documentElement.dataset.theme==="dark"'));
        await click('dialog [data-mode="light"]'); nativeTheme.themeSource = 'dark'; await pause(100);
        check('explicit light does not follow OS dark', await evaluate('document.documentElement.dataset.theme==="light"'));
        await click('dialog [data-mode="dark"]'); await click('[data-preset="#8b5cf6"]'); await closeDialog(); await shot('dashboard-dark');
        await win.webContents.reload(); await until(() => evaluate('document.querySelectorAll(".account-row").length===4').catch(() => false));
        check('appearance persists across renderer reload', await evaluate('document.documentElement.dataset.theme==="dark" && document.documentElement.style.getPropertyValue("--accent-fill")==="#8b5cf6"'));
        check('appearance never alters account file', fs.readFileSync(accountsFile, 'utf8') === beforeAppearance);
        await click('[data-open-appearance]'); await click('.restore-appearance'); await click('dialog [data-mode="light"]'); await shot('appearance-light'); await closeDialog();
        await shot('dashboard-light');
        win.setContentSize(920, 680); await pause(200);
        check('minimum desktop size has no horizontal overflow', await evaluate('document.documentElement.scrollWidth<=innerWidth'));
        await click('[data-open-appearance]'); check('appearance fits minimum desktop window', await evaluate('(()=>{const r=document.querySelector("dialog").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'));
        await shot('appearance-920'); await closeDialog(); win.setContentSize(1440, 960); await pause(350);
        // Real deletion via the menu removes only the record, never profile data.
        await click('[data-account="10001"] .more-button'); await click('.context-menu .danger-text'); await click('[data-confirm]');
        await until(() => evaluate('document.querySelectorAll(".account-row").length===3 && !document.querySelector("dialog")'));
        check('delete UI removes only selected record', !manager.accounts.some(a => a.id === '10001'));
        check('original fixture login bytes untouched', fs.readFileSync(path.join(profile, 'Preferences'), 'utf8') === '{"existing":true' && fs.readFileSync(path.join(profile, 'Cookies'), 'utf8') === 'fixture login marker');
        await evaluate('window.open("about:blank")'); await pause(100); check('new windows denied', BrowserWindow.getAllWindows().length === 1);
        const originalURL = win.webContents.getURL(); await evaluate('window.location.href="data:text/html,blocked"'); await pause(150); check('external navigation denied', win.webContents.getURL() === originalURL);
        await click('#nav-update-btn');
        check('ready update survives renderer reload and stale no-update events', installed === 0 && await evaluate('document.querySelector("dialog .button.primary").textContent === "完成更新"'));
        await closeDialog();
    }
    await shot('final');
    const expectedSecurityMessages = errors.filter(message => message === 'Not allowed to navigate top frame to data URL: data:text/html,blocked');
    const unexpectedErrors = errors.filter(message => !expectedSecurityMessages.includes(message));
    check('no unexpected renderer errors', unexpectedErrors.length === 0);
    const result = { mode, security, electron: process.versions.electron, root, checks, errors: unexpectedErrors, expectedSecurityMessages, passed: true };
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ mode, passed: true, checks: checks.length, root, screenshot: path.join(root, mode === 'real' ? 'real-chrome-dashboard.png' : mode === 'corrupt' ? 'final.png' : 'dashboard-light.png') }));
    clearTimeout(timeout); app.exit(0);
}).catch(async error => {
    console.error(error.stack, root); fs.writeFileSync(path.join(root, 'error.txt'), error.stack);
    if (mode === 'real' && manager) await manager.closeAllProfiles().catch(() => {});
    fs.writeFileSync(path.join(root, 'partial-results.json'), JSON.stringify({ checks, errors }, null, 2)); app.exit(1);
});
