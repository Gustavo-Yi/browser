'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { AccountManager } = require('./lib/account-manager');
const { validateId, migrateLegacyData } = require('./lib/storage');
const { listProcesses } = require('./lib/windows-processes');
const { trustedSender, protectWindow } = require('./lib/security');

autoUpdater.logger = log;
log.transports.file.level = 'info';
let mainWindow = null;
let focusTimer;
const singleInstance = app.requestSingleInstanceLock();
function safeSend(win, channel, value) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, value);
}
function holdInFront() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show(); mainWindow.setAlwaysOnTop(true); mainWindow.focus();
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
    }, 2200);
}

async function createWindow() {
    // Keep app name and paths unchanged across upgrades: Chrome logins depend on them.
    const userData = app.getPath('userData');
    let migrationError;
    try {
        await migrateLegacyData(userData, [path.join(app.getPath('appData'), '钰彤指纹浏览器')], listProcesses);
    } catch (error) { migrationError = error.message; log.warn('Legacy migration stopped safely', error); }
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const entry = path.join(__dirname, 'index.html');
    const entryURL = pathToFileURL(entry).href;
    const win = new BrowserWindow({
        width: Math.min(1440, Math.max(920, workArea.width - 100)),
        height: Math.min(960, Math.max(680, workArea.height - 80)),
        minWidth: 900, minHeight: 680, center: true,
        title: 'YT多开浏览器', icon: path.join(__dirname, 'yutonglogo.png'), autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false }
    });
    mainWindow = win;
    protectWindow(win, entryURL);
    const manager = new AccountManager({ userData, log, focus: holdInFront });
    if (migrationError) manager.accountsStore.error = '旧数据迁移未完成，已启用只读保护：' + migrationError;
    manager.on('state', state => safeSend(win, 'app-state', state));
    manager.on('launch-progress', progress => safeSend(win, 'launch-progress', progress));
    const registered = [];
    function handle(channel, action) {
        registered.push(channel);
        ipcMain.handle(channel, async (event, data) => {
            if (!trustedSender(event, win.webContents, entryURL)) return { ok: false, message: '不允许的调用来源。' };
            try { return { ok: true, ...await action(data) }; }
            catch (error) {
                log.warn('Operation failed: ' + channel, error);
                return { ok: false, message: error.message || '操作失败，原有环境数据未删除。' };
            }
        });
    }
    function fields(value, allowed) {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).some(key => !allowed.includes(key))) throw new Error('操作参数不合法。');
        return value;
    }
    handle('get-state', async () => { await manager.refresh().catch(() => {}); return manager.getState(); });
    handle('get-version', () => ({ version: app.getVersion() }));
    handle('add-account', data => manager.addAccounts(fields(data, ['name'])));
    handle('add-bulk-accounts', data => manager.addAccounts(fields(data, ['prefix', 'count'])));
    handle('update-account', data => manager.updateAccount(fields(data, ['id', 'name'])));
    handle('delete-account', id => manager.deleteAccount(validateId(id)));
    handle('launch-profile', id => manager.launchProfile(validateId(id)));
    handle('close-profile', id => manager.closeProfile(validateId(id)));
    handle('launch-all-profiles', () => manager.launchAllProfilesInOrder());
    handle('close-all-profiles', () => manager.closeAllProfiles());
    handle('open-profile-folder', async id => {
        validateId(id);
        if (!manager.accounts.some(acc => acc.id === id)) throw new Error('环境不存在。');
        fs.mkdirSync(manager.getProfilePath(id), { recursive: true });
        const error = await shell.openPath(manager.getProfilePath(id));
        if (error) throw new Error(error);
    });
    handle('open-profiles-root', async () => {
        fs.mkdirSync(manager.profilesRoot, { recursive: true });
        const error = await shell.openPath(manager.profilesRoot);
        if (error) throw new Error(error);
    });
    handle('select-chrome-path', async () => {
        const result = await dialog.showOpenDialog(win, { title: '选择 Chrome', properties: ['openFile'], filters: [{ name: 'Chrome', extensions: ['exe'] }] });
        if (result.canceled) return { canceled: true };
        manager.setChromePath(result.filePaths[0]); return {};
    });
    handle('open-chrome-download', () => shell.openExternal('https://www.google.com/chrome/'));

    let allowClose = false;
    let closePrompt = false;
    let updating = false;
    let updateState = 'idle';
    const notifyUpdate = (type, data = {}) => safeSend(win, 'update-status', { type, ...data });
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    const updaterEvents = [];
    function onUpdate(event, callback) {
        autoUpdater.on(event, callback); updaterEvents.push([event, callback]);
    }
    function updateFailed(error) {
        log.warn('Update failed', error); updateState = 'error';
        notifyUpdate('error', { message: error.message || '更新失败，请稍后重试。' });
    }
    onUpdate('update-available', info => {
        updateState = 'downloading'; notifyUpdate('available', { version: info.version });
        autoUpdater.downloadUpdate().catch(updateFailed);
    });
    onUpdate('download-progress', info => notifyUpdate('progress', { percent: info.percent }));
    onUpdate('update-downloaded', () => { updateState = 'ready'; notifyUpdate('ready'); });
    onUpdate('update-not-available', () => { updateState = 'idle'; notifyUpdate('none'); });
    onUpdate('error', updateFailed);
    handle('check-update', async () => {
        if (updateState === 'ready') { notifyUpdate('ready'); return {}; }
        if (['checking', 'downloading'].includes(updateState)) return {};
        if (!app.isPackaged) { notifyUpdate('development'); return {}; }
        updateState = 'checking'; notifyUpdate('checking');
        try { await autoUpdater.checkForUpdates(); } catch (error) { updateFailed(error); }
        return {};
    });
    handle('restart-update', async () => {
        if (updateState !== 'ready' || updating) throw new Error('更新尚未准备好。');
        if (manager.busy) throw new Error('请等待当前浏览器操作完成后再更新。');
        updating = true;
        try {
            const result = await manager.closeAllProfiles();
            if (result.failed) throw new Error('仍有浏览器未正常退出，请手动关闭后重试；本次未安装更新。');
            allowClose = true; autoUpdater.quitAndInstall(true, true);
        } finally { updating = false; }
    });
    win.on('close', async event => {
        if (allowClose) return;
        event.preventDefault();
        if (closePrompt) return;
        closePrompt = true;
        try {
            if (manager.busy || updating) {
                await dialog.showMessageBox(win, { type: 'info', message: '请等待当前启动、关闭或更新操作完成后再退出。' });
                return;
            }
            await manager.refresh().catch(() => {});
            if (manager.getRunningCount() || manager.processError) {
                const { response } = await dialog.showMessageBox(win, {
                    type: 'question', title: '关闭客户端',
                    message: manager.processError ? '暂时无法确认浏览器状态' : '当前有 ' + manager.getRunningCount() + ' 个浏览器环境正在运行',
                    detail: '只关闭客户端会保留 Chrome；下次打开客户端会重新识别。浏览器无法正常关闭时不会强制结束。',
                    buttons: ['只关闭客户端', '同时关闭浏览器', '取消'], defaultId: 0, cancelId: 2, noLink: true
                });
                if (response === 2) return;
                if (response === 1) {
                    const result = await manager.closeAllProfiles();
                    if (result.failed) {
                        await dialog.showMessageBox(win, { type: 'warning', message: '有 ' + result.failed + ' 个环境尚未退出，请检查浏览器提示或手动关闭。' });
                        return;
                    }
                }
            }
            allowClose = true; win.close();
        } catch (error) {
            log.warn('Close failed', error);
            await dialog.showMessageBox(win, { type: 'warning', message: error.message });
        } finally { closePrompt = false; }
    });
    const timer = setInterval(() => { if (!manager.busy) void manager.refresh().catch(() => {}); }, 5000);
    timer.unref();
    win.on('closed', () => {
        clearInterval(timer); clearTimeout(focusTimer); manager.removeAllListeners();
        for (const channel of registered) ipcMain.removeHandler(channel);
        for (const [event, callback] of updaterEvents) autoUpdater.removeListener(event, callback);
        mainWindow = null;
    });
    await win.loadFile(entry);
    await manager.refresh().catch(() => {});
}
if (!singleInstance) app.quit();
else {
    app.on('second-instance', () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show(); mainWindow.focus();
    });
    app.whenReady().then(createWindow).catch(error => {
        log.error('Startup failed', error); dialog.showErrorBox('启动失败', error.message); app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
