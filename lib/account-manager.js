'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { JsonStore, validateAccounts, validateConfig, validateId, profilePath } = require('./storage');
const windowsProcesses = require('./windows-processes');
const { BrowserGuard } = require('./browser-guard');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function accountName(value) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw new Error('环境名称需要为 1 到 200 个字符。');
    return value.trim();
}

function findChromePath(config) {
    const candidates = [config.chromePath];
    for (const key of ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER']) {
        try {
            const output = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
                ['query', key + '\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve'],
                { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
            const match = output.match(/REG_SZ\s+(.*)/);
            if (match) candidates.push(match[1].trim());
        } catch { /* Try standard installation paths. */ }
    }
    candidates.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'));
    return candidates.find(file => typeof file === 'string' && path.isAbsolute(file) &&
        path.basename(file).toLowerCase() === 'chrome.exe' && fs.existsSync(file) && fs.statSync(file).isFile()) || null;
}

class AccountManager extends EventEmitter {
    constructor({ userData, processes = windowsProcesses, spawnProcess = spawn, findChrome = findChromePath,
        log = console, focus = () => {}, launchTimeout = 10000, closeTimeout = 10000, pollDelay = 400,
        guard = processes === windowsProcesses && spawnProcess === spawn ? new BrowserGuard() : null }) {
        super();
        this.userData = userData;
        this.profilesRoot = path.join(userData, 'profiles');
        this.accountsStore = new JsonStore(path.join(userData, 'accounts.json'), validateAccounts, []);
        if (this.accountsStore.raw === null && !this.accountsStore.error &&
            fs.existsSync(this.profilesRoot) && fs.readdirSync(this.profilesRoot).length) {
            this.accountsStore.error = '检测到已有浏览器数据，但环境列表缺失。已启用只读保护，请先恢复 accounts.json；原数据目录未修改。';
        }
        this.configStore = new JsonStore(path.join(userData, 'config.json'), validateConfig, { chromePath: '' });
        this.processes = processes;
        this.guard = guard;
        this.spawnProcess = guard ? guard.spawn.bind(guard) : spawnProcess;
        this.findChrome = findChrome;
        this.log = log;
        this.focus = focus;
        this.launchTimeout = launchTimeout;
        this.closeTimeout = closeTimeout;
        this.pollDelay = pollDelay;
        this.activeProcesses = new Map();
        this.processError = '正在核对浏览器状态';
        this.busy = false;
        this.shuttingDown = false;
        this.queue = Promise.resolve();
        this.refreshPromise = null;
        // No startup save, no Chrome Preferences/Cookies writes, no ID migration.
    }

    get accounts() { return this.accountsStore.value; }
    getProfilePath(id) { return profilePath(this.profilesRoot, id); }
    getRunningCount() { return this.activeProcesses.size; }
    getState() {
        return {
            accounts: this.accounts.map(acc => ({ ...acc, isRunning: this.activeProcesses.has(acc.id), statusUnknown: !!this.processError })),
            busy: this.busy || this.shuttingDown,
            warning: [this.accountsStore.error, this.configStore.error, this.processError].filter(Boolean).join('\n'),
            readOnly: !!this.accountsStore.error,
            statusKnown: !this.processError
        };
    }
    publish() { this.emit('state', this.getState()); }

    beginShutdown() { this.shuttingDown = true; this.publish(); }
    cancelShutdown() { this.shuttingDown = false; this.publish(); }
    ensureLaunchAllowed() { if (this.shuttingDown) throw Error('客户端正在退出，已停止新的浏览器启动。'); }
    async waitForBrowserExit() { if (this.guard) await this.guard.waitFor(); }
    async forceCloseAllProfiles() {
        if (!this.shuttingDown || !this.guard) throw Error('只能在确认退出时强制关闭受保护的浏览器。');
        await this.queue;
        await this.refresh();
        await this.guard.forceAll();
        await this.refresh();
        if (this.getRunningCount()) throw Error('仍有浏览器未退出，客户端将继续运行。');
    }

    async refresh() {
        if (this.refreshPromise) return this.refreshPromise;
        this.refreshPromise = (async () => {
            try {
                const processes = await this.processes.listProcesses(this.profilesRoot);
                const next = new Map();
                // Runtime ownership is the exact profiles root, not a fixed count or
                // a possibly stale account list. Old/unlisted YT environments also close.
                for (const record of processes) {
                    if (!windowsProcesses.samePath(path.win32.dirname(record.profile), this.profilesRoot)) continue;
                    const id = validateId(path.win32.basename(record.profile));
                    if (!windowsProcesses.samePath(record.profile, this.getProfilePath(id))) continue;
                    if (this.guard) {
                        try { await this.guard.adopt(record); }
                        catch (error) {
                            // The inventory is a snapshot: Chrome may exit while the
                            // helper is opening its handle. Absence is not a protection error.
                            const current = await this.processes.listProcesses(this.profilesRoot);
                            const stillThere = current.some(item => windowsProcesses.identity(item) === windowsProcesses.identity(record) &&
                                item.commandLine === record.commandLine && windowsProcesses.samePath(item.profile, record.profile));
                            if (stillThere) throw error;
                            continue;
                        }
                    }
                    if (!next.has(id)) next.set(id, []);
                    next.get(id).push(record);
                }
                this.activeProcesses = next;
                this.processError = null;
            } catch (error) {
                this.processError = '无法核对浏览器状态，已停止启动/关闭操作。请重试或重启客户端。';
                this.log.warn('Process reconciliation failed', error);
                throw new Error(this.processError);
            } finally { this.publish(); }
        })();
        try { return await this.refreshPromise; } finally { this.refreshPromise = null; }
    }

    exclusive(action) {
        const operation = this.queue.then(async () => {
            this.busy = true; this.publish();
            try { return await action(); } finally { this.busy = false; this.publish(); }
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    ensureWritable() {
        if (this.accountsStore.error) throw new Error(this.accountsStore.error);
    }

    addAccounts({ name, prefix, count = 1 }) {
        this.ensureWritable();
        if (!Number.isInteger(count) || count < 1 || count > 200) throw new Error('批量数量必须为 1 到 200。');
        const base = accountName(name ?? prefix);
        const width = Math.max(2, String(count).length);
        const created = Array.from({ length: count }, (_, index) => ({
            id: randomUUID(), name: count === 1 && name != null ? base : base + '-' + String(index + 1).padStart(width, '0'), lastUsed: ''
        }));
        this.accountsStore.save([...this.accounts, ...created]); this.publish();
        return { created: created.length };
    }

    updateAccount({ id, name }) {
        this.ensureWritable(); validateId(id);
        if (!this.accounts.some(acc => acc.id === id)) throw new Error('环境不存在。');
        const nextName = accountName(name);
        this.accountsStore.save(this.accounts.map(acc => acc.id === id ? { ...acc, name: nextName } : acc));
        this.publish(); return {};
    }

    deleteAccount(id) {
        return this.exclusive(async () => {
            this.ensureWritable(); validateId(id);
            await this.refresh();
            if (this.activeProcesses.has(id)) throw new Error('请先关闭该浏览器环境，再从列表删除。数据目录仍会保留。');
            if (!this.accounts.some(acc => acc.id === id)) throw new Error('环境不存在。');
            this.accountsStore.save(this.accounts.filter(acc => acc.id !== id));
            this.publish(); return {};
        });
    }

    setChromePath(file) {
        if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== 'chrome.exe' ||
            !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('请选择已安装的 chrome.exe。');
        this.configStore.save({ ...this.configStore.value, chromePath: file });
    }

    launchProfile(id) { return this.exclusive(() => this.launchOne(id)); }

    async launchOne(id) {
        this.ensureLaunchAllowed();
        this.ensureWritable(); validateId(id);
        if (!this.accounts.some(acc => acc.id === id)) throw new Error('环境不存在。');
        await this.refresh();
        this.ensureLaunchAllowed();
        if (this.activeProcesses.has(id)) return { ok: false, reason: 'already-running', message: '该环境已在运行。' };
        const chromePath = this.findChrome(this.configStore.value);
        if (!chromePath) return { ok: false, reason: 'chrome-not-found', message: '未找到 Chrome，请选择 chrome.exe。' };
        const target = this.getProfilePath(id);
        fs.mkdirSync(target, { recursive: true });
        this.getProfilePath(id); // Recheck real-path containment after creation.
        const args = ['--user-data-dir=' + target, '--no-first-run', '--no-default-browser-check',
            '--start-maximized', '--restore-last-session', '--hide-crash-restore-bubble', '--disable-background-mode'];
        let child; let spawnError = null; let exited = false;
        try {
            child = this.spawnProcess(chromePath, args, { stdio: 'ignore', windowsHide: true });
            child.on('error', error => { spawnError = error; });
            child.on('exit', () => { exited = true; void this.refresh().catch(() => {}); });
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('等待 Chrome 启动超时。')), this.launchTimeout);
                const done = error => { clearTimeout(timer); child.removeListener('spawn', success); child.removeListener('error', failure); error ? reject(error) : resolve(); };
                const success = () => done();
                const failure = error => done(error);
                child.once('spawn', success); child.once('error', failure);
            });
            child.unref();
            const deadline = Date.now() + this.launchTimeout;
            do {
                await sleep(this.pollDelay);
                await this.refresh();
                if (this.activeProcesses.has(id)) {
                    let warning;
                    try {
                        const lastUsed = new Date().toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
                        this.accountsStore.save(this.accounts.map(acc => acc.id === id ? { ...acc, lastUsed } : acc));
                    } catch (error) { warning = '浏览器已启动，但使用时间保存失败：' + error.message; }
                    this.focus(); this.publish();
                    return { ok: true, id, warning };
                }
                if (spawnError || exited) break;
            } while (Date.now() < deadline);
            return { ok: false, reason: 'launch-failed', message: '未确认 Chrome 环境启动成功，请检查 Chrome 路径或稍后重试。' };
        } catch (error) {
            child?.abort?.();
            child?.unref();
            this.log.warn('Chrome launch failed', error);
            return { ok: false, reason: 'launch-failed', message: '启动失败：' + error.message };
        }
    }

    launchAllProfilesInOrder() {
        return this.exclusive(async () => {
            this.ensureLaunchAllowed();
            this.ensureWritable();
            await this.refresh();
            const pending = this.accounts.filter(acc => !this.activeProcesses.has(acc.id));
            const result = { requested: pending.length, launched: 0, skipped: this.accounts.length - pending.length, failed: 0, errors: [] };
            for (const [index, account] of pending.entries()) {
                if (this.shuttingDown) { result.canceled = pending.length - index; break; }
                const launch = await this.launchOne(account.id);
                if (launch.ok) result.launched++;
                else if (launch.reason === 'already-running') result.skipped++;
                else { result.failed++; result.errors.push({ id: account.id, message: launch.message }); }
                this.emit('launch-progress', { current: index + 1, total: pending.length });
                if (launch.reason === 'chrome-not-found') { result.reason = launch.reason; break; }
                if (index + 1 < pending.length) await sleep(650);
            }
            return result;
        });
    }

    closeProfile(id) {
        validateId(id);
        if (!this.accounts.some(acc => acc.id === id)) throw new Error('环境不存在。');
        return this.closeProfiles([id]);
    }

    closeAllProfiles() { return this.closeProfiles(); }

    closeProfiles(ids = null) {
        return this.exclusive(async () => {
            await this.refresh();
            const targets = [...this.activeProcesses.keys()].filter(id => ids === null || ids.includes(id));
            const errors = new Map();
            for (const id of targets) {
                const records = this.activeProcesses.get(id) || [];
                for (const record of records) {
                    try { await this.processes.requestClose(record); }
                    catch (error) { errors.set(id, error.message); }
                }
            }
            const deadline = Date.now() + this.closeTimeout;
            do {
                await this.refresh();
                if (targets.every(id => !this.activeProcesses.has(id)) || targets.every(id => !this.activeProcesses.has(id) || errors.has(id))) break;
                await sleep(this.pollDelay);
            } while (Date.now() < deadline);
            const failedIds = targets.filter(id => this.activeProcesses.has(id));
            // Retain failed instances. Never falsify a normal exit or rewrite Preferences.
            return {
                closed: targets.length - failedIds.length, failed: failedIds.length,
                errors: failedIds.map(id => ({ id, message: errors.get(id) || 'Chrome 尚未退出，请检查浏览器提示或手动关闭。未强制结束进程。' }))
            };
        });
    }
}

module.exports = { AccountManager, findChromePath, accountName };
