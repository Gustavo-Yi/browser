'use strict';
const electron = require('electron');
const { app, BrowserWindow, Tray } = electron;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const { AccountManager } = require('../lib/account-manager');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-lifecycle-electron-'));
const mode = process.argv[2] || 'window';
app.setPath('userData', root); app.setPath('appData', root); app.setPath('sessionData', root);
app.commandLine.appendSwitch('disable-gpu');
const accounts = Array.from({ length: 7 }, (_, i) => ({ id: 'env-' + i, name: 'Isolated ' + i }));
fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify(accounts));
let records = accounts.map((item, i) => ({ pid: 900001 + i, profile: path.join(root, 'profiles', item.id) }));
let win, tray, menu, manager, visible = true, quitCount = 0;
let response = 2;
const prompts = [], checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 500; i++) { if (await fn()) return; await pause(20); } throw Error('Lifecycle UI timeout'); }
app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault() { prevented = true; } });
    if (!prevented) { assert.equal(records.length, 0, 'All profiles must exit BEFORE app quits'); quitCount++; }
};
const updater = new EventEmitter(); updater.checkForUpdates = async () => {};
const load = Module._load;
Module._load = function(request, parent, ...rest) {
    if (parent?.filename === path.join(__dirname, '..', 'main.js')) {
        if (request === 'electron') return { ...electron,
            BrowserWindow: function(options) {
                win = new BrowserWindow({ ...options, show: false });
                win.show = () => { visible = true; }; win.hide = () => { visible = false; };
                win.focus = () => {}; win.setAlwaysOnTop = () => {};
                return win;
            },
            Tray: function(icon) {
                assert(!electron.nativeImage.createFromPath(icon).isEmpty());
                tray = new Tray(icon);
                const set = tray.setContextMenu.bind(tray);
                tray.setContextMenu = value => { menu = value; set(value); };
                return tray;
            },
            dialog: { showErrorBox: (_title, message) => { throw Error(message); },
                showMessageBox: async (_win, options) => { prompts.push(options); return { response }; }
            }
        };
        if (request === 'electron-updater') return { autoUpdater: updater };
        if (request === './lib/account-manager') return { AccountManager: class extends AccountManager {
            constructor(options) {
                super({ ...options, guard: null, pollDelay: 1,
                    processes: { listProcesses: async () => [...records], requestClose: async record => { records = records.filter(x => x !== record); } }
                }); manager = this;
            }
        } };
    }
    return load.call(this, request, parent, ...rest);
};
require('../main');
(async () => {
    await until(() => win && tray && manager?.getRunningCount() === 7 && !win.webContents.isLoading() && win.webContents.getURL().endsWith('/index.html'));
    await pause(100);
    assert(!tray.isDestroyed()); assert.equal(menu.items[0].label, '打开主界面');
    checks.push('real native tray icon and menu created');
    if (mode === 'window') {
        win.close(); await until(() => prompts.length === 1); await pause(50);
        assert(!win.isDestroyed()); assert.equal(records.length, 7); assert.equal(visible, true);
        assert.deepEqual(prompts[0].buttons, ['最小化到托盘', '关闭浏览器并退出', '取消']);
        assert.equal(prompts[0].cancelId, 2); checks.push('close dialog / safe cancel');
        response = 0; win.close(); await until(() => !visible);
        assert.equal(records.length, 7); assert.equal(quitCount, 0); checks.push('minimize keeps all seven environments');
        tray.emit('double-click'); assert.equal(visible, true);
        response = 0; win.close(); await until(() => !visible);
        app.emit('second-instance'); assert.equal(visible, true); checks.push('tray double-click and second instance restore existing window');
        response = 1; win.close();
    } else if (mode === 'tray') {
        menu.items.at(-1).click();
    } else if (mode === 'session') {
        let prevented = false;
        win.emit('query-session-end', { preventDefault() { prevented = true; } });
        assert(prevented); assert.equal(prompts.length, 0); checks.push('session end delays shutdown without close-choice dialog');
    } else { app.quit(); }
    await until(() => quitCount === 1);
    assert.equal(records.length, 0); assert.equal(manager.shuttingDown, true);
    checks.push(mode + ': all seven browsers closed before quit');
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ passed: true, mode, checks }, null, 2));
    console.log(JSON.stringify({ passed: true, mode, checks, root })); app.exit(0);
})().catch(error => { console.error(error.stack, root); app.exit(1); });
setTimeout(() => { console.error('Lifecycle test watchdog', root); app.exit(2); }, 30000).unref();
