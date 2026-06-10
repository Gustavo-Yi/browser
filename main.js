const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// 配置日志
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');

const RECOVERABLE_NETWORK_CODES = new Set([
    'ECONNRESET',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EPIPE',
]);

function normalizeError(error) {
    if (error instanceof Error) return error;
    return new Error(typeof error === 'string' ? error : JSON.stringify(error));
}

function isRecoverableNetworkError(error) {
    const err = normalizeError(error);
    return RECOVERABLE_NETWORK_CODES.has(err.code) || /ECONNRESET|socket hang up|network|timeout/i.test(err.message);
}

function logRecoverableNetworkError(source, error) {
    const err = normalizeError(error);
    log.warn(`${source}: ${err.code || 'NETWORK'} ${err.message}`);
}

process.on('uncaughtException', (error) => {
    if (isRecoverableNetworkError(error)) {
        logRecoverableNetworkError('Recovered uncaught network error', error);
        return;
    }

    log.error('Uncaught exception', error);
    dialog.showErrorBox('程序错误', normalizeError(error).stack || normalizeError(error).message);
});

process.on('unhandledRejection', (reason) => {
    if (isRecoverableNetworkError(reason)) {
        logRecoverableNetworkError('Recovered unhandled network rejection', reason);
        return;
    }

    log.error('Unhandled rejection', reason);
});

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

/**
 * 核心路径配置修正 (打包兼容性关键)
 * 不再使用 __dirname，而是使用系统提供的可写目录 app.getPath('userData')
 */
const USER_DATA = app.getPath('userData');
const PROFILES_ROOT = path.join(USER_DATA, 'profiles');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');
const LEGACY_USER_DATA_PATHS = [
    path.join(app.getPath('appData'), '钰彤指纹浏览器')
];

function readAccountArray(filePath) {
    try {
        if (!fs.existsSync(filePath)) return [];
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(value) ? value : [];
    } catch (error) {
        log.warn(`Unable to read account file: ${filePath}`, error);
        return [];
    }
}

function isNonEmptyDirectory(dirPath) {
    try {
        return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
    } catch (error) {
        log.warn(`Unable to inspect directory: ${dirPath}`, error);
        return false;
    }
}

function copyMissingDirectory(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) return;
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    for (const item of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, item.name);
        const targetPath = path.join(targetDir, item.name);
        if (item.isDirectory()) {
            copyMissingDirectory(sourcePath, targetPath);
        } else if (!fs.existsSync(targetPath)) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function migrateLegacyUserData() {
    const currentAccountsPath = path.join(USER_DATA, 'accounts.json');
    let hasCurrentAccounts = readAccountArray(currentAccountsPath).length > 0;

    for (const legacyUserData of LEGACY_USER_DATA_PATHS) {
        if (!fs.existsSync(legacyUserData) || legacyUserData === USER_DATA) continue;

        const legacyAccountsPath = path.join(legacyUserData, 'accounts.json');
        const legacyAccounts = readAccountArray(legacyAccountsPath);
        if (!hasCurrentAccounts && legacyAccounts.length > 0) {
            if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
            fs.copyFileSync(legacyAccountsPath, currentAccountsPath);
            hasCurrentAccounts = true;
            log.info(`Migrated ${legacyAccounts.length} accounts from ${legacyUserData}`);
        }

        const legacyConfigPath = path.join(legacyUserData, 'config.json');
        if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(legacyConfigPath)) {
            if (!fs.existsSync(USER_DATA)) fs.mkdirSync(USER_DATA, { recursive: true });
            fs.copyFileSync(legacyConfigPath, CONFIG_PATH);
            log.info(`Migrated config from ${legacyUserData}`);
        }

        const legacyProfilesRoot = path.join(legacyUserData, 'profiles');
        if (isNonEmptyDirectory(legacyProfilesRoot) && !isNonEmptyDirectory(PROFILES_ROOT)) {
            copyMissingDirectory(legacyProfilesRoot, PROFILES_ROOT);
            log.info(`Migrated profiles from ${legacyProfilesRoot}`);
        }
    }
}

migrateLegacyUserData();
if (!fs.existsSync(PROFILES_ROOT)) fs.mkdirSync(PROFILES_ROOT, { recursive: true });

function normalizeAccount(account) {
    return {
        id: String(account.id || Date.now()),
        name: String(account.name || '').trim(),
        lastUsed: account.lastUsed || ''
    };
}

function formatLaunchTime() {
    return new Date().toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
}

class AccountManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.activeProcesses = new Map();
        this.accounts = this.loadAccounts();
        this.config = this.loadConfig();
        this.saveAccounts();
    }

    loadAccounts() {
        const filePath = path.join(USER_DATA, 'accounts.json');
        try {
            if (fs.existsSync(filePath)) {
                const accounts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                return Array.isArray(accounts) ? accounts.map(normalizeAccount) : [];
            }
        } catch (e) {}
        return [];
    }

    saveAccounts() {
        const filePath = path.join(USER_DATA, 'accounts.json');
        this.accounts = this.accounts.map(normalizeAccount);
        fs.writeFileSync(filePath, JSON.stringify(this.accounts, null, 2), 'utf8');
    }

    loadConfig() {
        try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
        return { chromePath: '' };
    }

    saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2)); }

    getProfilePath(accountId) {
        return path.join(PROFILES_ROOT, String(accountId));
    }

    getAccountsView() {
        return this.accounts.map(acc => ({ ...acc, isRunning: this.activeProcesses.has(acc.id) }));
    }

    findChromePath() {
        if (this.config.chromePath && fs.existsSync(this.config.chromePath)) return this.config.chromePath;
        const regPaths = ['HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe','HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe'];
        for (const regPath of regPaths) {
            try {
                const output = execSync(`reg query "${regPath}" /ve`).toString();
                const match = output.match(/REG_SZ\s+(.*)/);
                if (match && match[1] && fs.existsSync(match[1].trim())) return match[1].trim();
            } catch (e) {}
        }
        const commonPaths = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe","C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",path.join(process.env.LOCALAPPDATA || '', "Google\\Chrome\\Application\\chrome.exe")];
        for (const p of commonPaths) if (fs.existsSync(p)) return p;
        return null;
    }

    async launchProfile(accountId) {
        const chromePath = this.findChromePath();
        if (!chromePath) { this.mainWindow.webContents.send('chrome-not-found'); return; }

        const account = this.accounts.find(a => a.id === accountId);
        if (!account || this.activeProcesses.has(accountId)) return;

        const profilePath = this.getProfilePath(accountId);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });

        const args = [
            `--user-data-dir=${profilePath}`,
            "--no-first-run", "--no-default-browser-check", "--start-maximized", "--new-window"
        ];

        try {
            const child = spawn(chromePath, args, { detached: true });
            account.lastUsed = formatLaunchTime();
            this.saveAccounts();
            this.activeProcesses.set(accountId, child.pid);
            this.mainWindow.webContents.send('process-started', accountId);
            this.mainWindow.webContents.send('accounts-list', this.getAccountsView());
            child.on('error', (err) => {
                log.error('Failed to launch Chrome', err);
                this.activeProcesses.delete(accountId);
                this.mainWindow.webContents.send('process-ended', accountId);
            });
            child.on('exit', () => {
                this.activeProcesses.delete(accountId);
                this.mainWindow.webContents.send('process-ended', accountId);
            });
            child.unref();
        } catch (err) {
            log.error('Failed to launch Chrome', err);
        }
    }

    async openProfileFolder(accountId) {
        const account = this.accounts.find(a => a.id === String(accountId));
        if (!account) return;
        const profilePath = this.getProfilePath(account.id);
        if (!fs.existsSync(profilePath)) fs.mkdirSync(profilePath, { recursive: true });
        await shell.openPath(profilePath);
    }

    async openProfilesRoot() {
        if (!fs.existsSync(PROFILES_ROOT)) fs.mkdirSync(PROFILES_ROOT, { recursive: true });
        await shell.openPath(PROFILES_ROOT);
    }
}

function createWindow() {
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    const windowWidth = Math.min(980, Math.max(920, workArea.width - 220));
    const windowHeight = Math.min(760, Math.max(680, workArea.height - 120));

    const win = new BrowserWindow({
        width: windowWidth,
        height: windowHeight,
        minWidth: 900,
        minHeight: 680,
        center: true,
        title: "YT多开浏览器",
        icon: path.join(__dirname, 'yutonglogo.png'),
        autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: true }
    });
    const manager = new AccountManager(win);
    win.loadFile('index.html');

    ipcMain.on('get-accounts', (e) => e.reply('accounts-list', manager.getAccountsView()));
    ipcMain.on('launch-profile', (e, id) => manager.launchProfile(id));
    ipcMain.on('add-account', (e, account) => {
        const newAccount = normalizeAccount({ ...account, id: Date.now().toString() });
        manager.accounts.push(newAccount); manager.saveAccounts();
        e.reply('accounts-list', manager.getAccountsView());
    });
    ipcMain.on('add-bulk-accounts', (e, data) => {
        const prefix = String(data?.prefix || '账号').trim() || '账号';
        const count = Math.max(1, Math.min(200, Number.parseInt(data?.count, 10) || 1));
        const width = String(count).length < 2 ? 2 : String(count).length;
        const createdAt = Date.now();
        for (let i = 1; i <= count; i += 1) {
            manager.accounts.push(normalizeAccount({
                id: `${createdAt}${String(i).padStart(3, '0')}`,
                name: `${prefix}-${String(i).padStart(width, '0')}`
            }));
        }
        manager.saveAccounts();
        e.reply('accounts-list', manager.getAccountsView());
    });
    ipcMain.on('update-account', (e, data) => {
        const index = manager.accounts.findIndex(a => a.id === data.id);
        if (index !== -1) { manager.accounts[index] = { ...manager.accounts[index], ...data }; manager.saveAccounts(); }
        e.reply('accounts-list', manager.getAccountsView());
    });
    ipcMain.on('delete-account', (e, id) => {
        manager.accounts = manager.accounts.filter(a => a.id !== id); manager.saveAccounts();
        e.reply('accounts-list', manager.getAccountsView());
    });
    ipcMain.on('save-accounts-order', (e, sortedAccounts) => {
        manager.accounts = sortedAccounts;
        manager.saveAccounts();
    });
    ipcMain.on('open-profile-folder', (e, id) => manager.openProfileFolder(id));
    ipcMain.on('open-profiles-root', () => manager.openProfilesRoot());

    // 获取当前版本号
    ipcMain.handle('get-version', () => app.getVersion());

    ipcMain.on('select-chrome-path', async (event) => {
        const result = await dialog.showOpenDialog(win, { title: "选择 Chrome", properties: ['openFile'], filters: [{ name: 'Executables', extensions: ['exe'] }] });
        if (!result.canceled && result.filePaths.length > 0) { manager.config.chromePath = result.filePaths[0]; manager.saveConfig(); event.reply('chrome-path-set', manager.config.chromePath); }
    });
    autoUpdater.autoDownload = false; // 禁用自动下载，等待用户点击按钮

    autoUpdater.on('update-available', (info) => {
        win.webContents.send('update-available', info);
    });

    autoUpdater.on('download-progress', (progress) => {
        win.webContents.send('update-progress', progress.percent);
    });

    autoUpdater.on('update-downloaded', (info) => {
        win.webContents.send('update-ready', info);
    });

    const handleUpdateError = (err) => {
        logRecoverableNetworkError('Update check failed', err);
        win.webContents.send('update-error', normalizeError(err));
    };

    const checkForUpdates = () => {
        if (!app.isPackaged) {
            log.info('Skip update check in development mode.');
            win.webContents.send('update-not-available', { version: app.getVersion(), dev: true });
            return Promise.resolve(null);
        }
        return autoUpdater.checkForUpdatesAndNotify().catch(handleUpdateError);
    };

    ipcMain.on('start-download', () => {
        autoUpdater.downloadUpdate().catch(handleUpdateError);
    });

    ipcMain.on('restart-app', () => {
        autoUpdater.quitAndInstall();
    });

    // 手动检查更新
    ipcMain.on('manual-check-update', () => {
        checkForUpdates();
    });

    autoUpdater.on('update-not-available', (info) => {
        win.webContents.send('update-not-available', info);
    });

    autoUpdater.on('error', (err) => {
        handleUpdateError(err);
    });

    // 可以在窗口显示后检查更新
    win.once('ready-to-show', () => {
        checkForUpdates();
    });
}
app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
