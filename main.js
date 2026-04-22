const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// 配置日志
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
log.info('App starting...');

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const net = require('net');
const { SocksClient } = require('socks');
const { spawn, execSync } = require('child_process');

/**
 * 核心路径配置修正 (打包兼容性关键)
 * 不再使用 __dirname，而是使用系统提供的可写目录 app.getPath('userData')
 */
const USER_DATA = app.getPath('userData');
const PROFILES_ROOT = path.join(USER_DATA, 'profiles');
const EXTENSIONS_ROOT = path.join(USER_DATA, 'temp_extensions');
const CONFIG_PATH = path.join(USER_DATA, 'config.json');

const UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
];

// 自动创建必要的持久化目录
if (!fs.existsSync(PROFILES_ROOT)) fs.mkdirSync(PROFILES_ROOT, { recursive: true });
if (!fs.existsSync(EXTENSIONS_ROOT)) fs.mkdirSync(EXTENSIONS_ROOT, { recursive: true });

class SocksBridge {
    constructor(upstream) {
        this.upstream = upstream; 
        this.server = null;
        this.port = 0;
    }

    async start() {
        return new Promise((resolve, reject) => {
            this.server = net.createServer((clientSocket) => {
                clientSocket.once('data', (data) => {
                    if (data[0] !== 0x05) return clientSocket.destroy();
                    clientSocket.write(Buffer.from([0x05, 0x00]));
                    clientSocket.once('data', async (req) => {
                        if (req[0] !== 0x05 || req[1] !== 0x01) return clientSocket.destroy();
                        let host, port;
                        const atyp = req[3];
                        if (atyp === 0x01) { host = req.slice(4, 8).join('.'); port = req.readUInt16BE(8); }
                        else if (atyp === 0x03) { const len = req[4]; host = req.slice(5, 5 + len).toString(); port = req.readUInt16BE(5 + len); }
                        if (!host || !port) return clientSocket.destroy();
                        try {
                            const info = await SocksClient.createConnection({
                                proxy: { host: this.upstream.host, port: parseInt(this.upstream.port), type: 5, userId: this.upstream.user, password: this.upstream.pass },
                                command: 'connect', destination: { host, port }
                            });
                            clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
                            clientSocket.pipe(info.socket).pipe(clientSocket);
                        } catch (err) { clientSocket.destroy(); }
                    });
                });
                clientSocket.on('error', () => clientSocket.destroy());
            });
            this.server.listen(0, '127.0.0.1', () => { this.port = this.server.address().port; resolve(this.port); });
            this.server.on('error', reject);
        });
    }
    stop() { if (this.server) this.server.close(); }
}

class AccountManager {
    constructor(mainWindow) {
        this.mainWindow = mainWindow;
        this.activeProcesses = new Map();
        this.bridges = new Map();
        this.accounts = this.loadAccounts();
        this.config = this.loadConfig();
    }

    loadAccounts() {
        const filePath = path.join(USER_DATA, 'accounts.json');
        try { if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) {}
        return [];
    }

    saveAccounts() {
        const filePath = path.join(USER_DATA, 'accounts.json');
        fs.writeFileSync(filePath, JSON.stringify(this.accounts, null, 2), 'utf8');
    }

    loadConfig() {
        try { if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) {}
        return { chromePath: '' };
    }

    saveConfig() { fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2)); }

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

    generateFingerprintExtension(account) {
        const extDir = path.join(EXTENSIONS_ROOT, account.id);
        if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });

        const p = this.parseProxy(account.proxy);
        const timezone = account.timezone || 'Asia/Shanghai';
        const lang = account.lang || 'zh-CN';
        const ua = account.ua || UA_LIST[0];

        const manifest = {
            "manifest_version": 3,
            "name": `F-Mask-${account.id}`,
            "version": "1.0",
            "permissions": ["webRequest", "webRequestAuthProvider", "privacy"],
            "host_permissions": ["<all_urls>"],
            "background": { "service_worker": "background.js" },
            "content_scripts": [{ "matches": ["<all_urls>"], "js": ["inject.js"], "run_at": "document_start", "world": "MAIN" }]
        };

        const background = `
chrome.webRequest.onAuthRequired.addListener(
    (details, callback) => { if (details.isProxy) { callback({ authCredentials: { username: "${p.user || ''}", password: "${p.pass || ''}" } }); } else { callback({}); } },
    { urls: ["<all_urls>"] }, ["asyncBlocking"]
);
chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'proxy_only' });
`;

        const inject = `
(function() {
    const spoofTimezone = "${timezone}";
    const originalDateTimeFormat = Intl.DateTimeFormat;
    Intl.DateTimeFormat = function(locale, options) { if (!options) options = {}; options.timeZone = spoofTimezone; return new originalDateTimeFormat(locale, options); };
    Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
    Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;
    Object.defineProperty(navigator, 'languages', { get: () => ["${lang}", "${lang.split('-')[0]}"] });
    Object.defineProperty(navigator, 'language', { get: () => "${lang}" });
    Object.defineProperty(navigator, 'userAgent', { get: () => "${ua}" });

    const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
        const imageData = originalGetImageData.apply(this, arguments);
        if (imageData.data.length > 0) imageData.data[0] = imageData.data[0] ^ 1;
        return imageData;
    };
})();
`;

        fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        fs.writeFileSync(path.join(extDir, 'background.js'), background);
        fs.writeFileSync(path.join(extDir, 'inject.js'), inject);
        return extDir;
    }

    parseProxy(proxyStr) {
        if (!proxyStr) return {};
        try { 
            const url = new URL(proxyStr.includes('://') ? proxyStr : 'socks5://' + proxyStr);
            return { protocol: url.protocol.replace(':', ''), host: url.hostname, port: url.port, user: url.username, pass: url.password }; 
        } catch (e) { return {}; }
    }

    async launchProfile(accountId) {
        const chromePath = this.findChromePath();
        if (!chromePath) { this.mainWindow.webContents.send('chrome-not-found'); return; }

        const account = this.accounts.find(a => a.id === accountId);
        if (!account || this.activeProcesses.has(accountId)) return;

        const profilePath = path.join(PROFILES_ROOT, accountId);
        const extPath = this.generateFingerprintExtension(account);

        const args = [
            `--user-data-dir=${profilePath}`,
            "--no-first-run", "--no-default-browser-check", "--enable-automation", "--start-maximized",
            `--user-agent=${account.ua || UA_LIST[0]}`,
            `--lang=${account.lang || 'zh-CN'}`,
            `--load-extension=${extPath}`,
            "https://web.whatsapp.com/"
        ];

        if (account.proxy) {
            const p = this.parseProxy(account.proxy);
            if (p.host && p.port) {
                if ((p.protocol === 'socks5' || p.protocol === 'socks') && p.user) {
                    try {
                        const bridge = new SocksBridge(p);
                        const localPort = await bridge.start();
                        this.bridges.set(accountId, bridge);
                        args.push(`--proxy-server=socks5://127.0.0.1:${localPort}`);
                    } catch (err) { console.error("Tunnel error", err); }
                } else {
                    // 默认开启 socks5h (远程 DNS) 以支持住宅代理
                    const protocol = p.protocol === 'socks5' ? 'socks5h' : p.protocol;
                    args.push(`--proxy-server=${protocol}://${p.host}:${p.port}`);
                }
            }
        }


        try {
            const child = spawn(chromePath, args, { detached: true });
            this.activeProcesses.set(accountId, child.pid);
            this.mainWindow.webContents.send('process-started', accountId);
            child.on('exit', () => {
                this.activeProcesses.delete(accountId);
                if (this.bridges.has(accountId)) { this.bridges.get(accountId).stop(); this.bridges.delete(accountId); }
                this.mainWindow.webContents.send('process-ended', accountId);
            });
            child.unref();
        } catch (err) {}
    }
}

function createWindow() {
    const win = new BrowserWindow({
        width: 1400, height: 900, title: "钰彤指纹浏览器", icon: path.join(__dirname, 'whatsapp.png'), autoHideMenuBar: true,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: false, nodeIntegration: true }
    });
    const manager = new AccountManager(win);
    win.maximize();
    win.loadFile('index.html');

    ipcMain.on('get-accounts', (e) => e.reply('accounts-list', manager.accounts.map(acc => ({ ...acc, isRunning: manager.activeProcesses.has(acc.id) }))));
    ipcMain.on('launch-profile', (e, id) => manager.launchProfile(id));
    ipcMain.on('add-account', (e, account) => {
        const newAccount = { ...account, id: Date.now().toString(), ua: UA_LIST[0] };
        manager.accounts.push(newAccount); manager.saveAccounts();
        e.reply('accounts-list', manager.accounts.map(acc => ({ ...acc, isRunning: manager.activeProcesses.has(acc.id) })));
    });
    ipcMain.on('update-account', (e, data) => {
        const index = manager.accounts.findIndex(a => a.id === data.id);
        if (index !== -1) { manager.accounts[index] = { ...manager.accounts[index], ...data }; manager.saveAccounts(); }
        e.reply('accounts-list', manager.accounts.map(acc => ({ ...acc, isRunning: manager.activeProcesses.has(acc.id) })));
    });
    ipcMain.on('delete-account', (e, id) => {
        manager.accounts = manager.accounts.filter(a => a.id !== id); manager.saveAccounts();
        e.reply('accounts-list', manager.accounts.map(acc => ({ ...acc, isRunning: manager.activeProcesses.has(acc.id) })));
    });
    ipcMain.handle('test-proxy', async (event, { host, port, user, pass }) => {
        // 使用 socks5h (远程 DNS) 进行检测，这对住宅代理更可靠
        let proxyUrl = `socks5h://${host}:${port}`; 
        if (user && pass) proxyUrl = `socks5h://${user}:${pass}@${host}:${port}`;
        
        try {
            const { SocksProxyAgent } = await import('socks-proxy-agent');
            const agent = new SocksProxyAgent(proxyUrl);
            
            // 增加超时到 20 秒，给慢速住宅 IP 足够时间
            const response = await axios.get('http://ip-api.com/json', { 
                httpAgent: agent, 
                httpsAgent: agent, 
                timeout: 20000 
            });
            
            if (response.data.status === 'success') return { success: true, ...response.data };
            return { success: false, error: '状态检测失败' };
        } catch (err) { 
            return { success: false, error: err.code === 'ECONNABORTED' ? '连接超时' : err.message }; 
        }
    });

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

    ipcMain.on('start-download', () => {
        autoUpdater.downloadUpdate();
    });

    ipcMain.on('restart-app', () => {
        autoUpdater.quitAndInstall();
    });

    // 手动检查更新
    ipcMain.on('manual-check-update', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });

    autoUpdater.on('update-not-available', (info) => {
        win.webContents.send('update-not-available', info);
    });

    autoUpdater.on('error', (err) => {
        win.webContents.send('update-error', err);
    });

    // 可以在窗口显示后检查更新
    win.once('ready-to-show', () => {
        autoUpdater.checkForUpdatesAndNotify();
    });
}
app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
