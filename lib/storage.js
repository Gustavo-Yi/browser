'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function validateId(value) {
    const id = String(value ?? '');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) {
        throw new Error('环境 ID 不合法，已停止操作以保护数据。');
    }
    return id;
}

function validateAccounts(value) {
    if (!Array.isArray(value)) throw new Error('环境列表格式不正确。');
    const ids = new Set();
    return value.map(account => {
        if (!account || typeof account !== 'object' || Array.isArray(account)) throw new Error('环境记录格式不正确。');
        const id = validateId(account.id);
        if (ids.has(id)) throw new Error('环境列表中存在重复 ID。');
        ids.add(id);
        if (typeof account.name !== 'string' || (account.lastUsed != null && typeof account.lastUsed !== 'string')) {
            throw new Error('环境名称或使用时间格式不正确。');
        }
        // Preserve legacy IDs and other metadata; never regenerate an ID on load.
        return { ...account, id, name: account.name, lastUsed: account.lastUsed || '' };
    });
}

function validateConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        (value.chromePath != null && typeof value.chromePath !== 'string')) throw new Error('Chrome 配置格式不正确。');
    return { ...value, chromePath: value.chromePath || '' };
}

function atomicWrite(file, content, io = fs) {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
        fd = io.openSync(temp, 'wx', 0o600);
        io.writeFileSync(fd, content, 'utf8');
        io.fsyncSync(fd);
        io.closeSync(fd); fd = undefined;
        // Never unlink the original first. A failed rename leaves it untouched.
        io.renameSync(temp, file);
    } finally {
        if (fd !== undefined) io.closeSync(fd);
        try { io.unlinkSync(temp); } catch { /* Leave original intact even if cleanup fails. */ }
    }
}

class JsonStore {
    constructor(file, validate, defaultValue, io = fs) {
        this.file = file;
        this.validate = validate;
        this.io = io;
        this.error = null;
        this.raw = null;
        this.value = defaultValue;
        try {
            this.raw = io.readFileSync(file, 'utf8');
            this.value = validate(JSON.parse(this.raw.replace(/^\uFEFF/, '')));
        } catch (error) {
            if (error.code === 'ENOENT' && !io.existsSync(file + '.bak')) return;
            this.error = '无法读取 ' + path.basename(file) + '，已启用只读保护。原文件未修改。' + error.message;
            try {
                this.value = validate(JSON.parse(io.readFileSync(file + '.bak', 'utf8').replace(/^\uFEFF/, '')));
                this.error += ' 当前显示上一份有效备份；恢复原文件前不能修改环境。';
            } catch { /* Never write default data over an unreadable original. */ }
        }
    }

    save(value) {
        if (this.error) throw new Error(this.error);
        const validated = this.validate(value);
        let current = null;
        try { current = this.io.readFileSync(this.file, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current !== this.raw) throw new Error('配置文件已被其他程序修改，请重启客户端重新读取；本次未覆盖文件。');
        if (current !== null) {
            this.validate(JSON.parse(current.replace(/^\uFEFF/, '')));
            atomicWrite(this.file + '.bak', current, this.io);
        }
        const next = JSON.stringify(validated, null, 2);
        atomicWrite(this.file, next, this.io);
        this.raw = next;
        this.value = validated;
        return validated;
    }
}

function profilePath(root, value) {
    const id = validateId(value);
    const target = path.resolve(root, id);
    if (path.dirname(target) !== path.resolve(root)) throw new Error('环境目录超出允许范围。');
    if (fs.existsSync(target)) {
        const relative = path.relative(fs.realpathSync(root), fs.realpathSync(target));
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('环境目录链接指向允许范围之外。');
    }
    return target;
}

// Never merge legacy data into an existing (even empty/corrupt) account list.
async function migrateLegacyData(userData, legacyDirs, listProcesses) {
    const currentList = path.join(userData, 'accounts.json');
    const profiles = path.join(userData, 'profiles');
    if (fs.existsSync(currentList) || fs.existsSync(currentList + '.bak') ||
        (fs.existsSync(profiles) && fs.readdirSync(profiles).length)) return;
    for (const legacy of legacyDirs) {
        if (path.resolve(legacy) === path.resolve(userData)) continue;
        const sourceList = path.join(legacy, 'accounts.json');
        if (!fs.existsSync(sourceList)) continue;
        const accounts = validateAccounts(JSON.parse(fs.readFileSync(sourceList, 'utf8').replace(/^\uFEFF/, '')));
        if (!accounts.length) continue;
        const sourceProfiles = path.join(legacy, 'profiles');
        if ((await listProcesses(sourceProfiles)).length) throw new Error('旧版本环境仍在运行，请先关闭旧版 Chrome 环境后再迁移。未修改旧数据。');
        fs.mkdirSync(userData, { recursive: true });
        const stage = path.join(userData, 'migration-' + randomUUID());
        fs.mkdirSync(stage);
        if (fs.existsSync(sourceProfiles)) {
            fs.cpSync(sourceProfiles, stage, { recursive: true, filter: source => {
                if (fs.lstatSync(source).isSymbolicLink()) throw new Error('旧数据中存在目录链接，请手动核对后迁移。');
                return true;
            }});
        }
        if ((await listProcesses(sourceProfiles)).length) throw new Error('迁移期间旧浏览器被启动，已保留旧数据，未切换环境列表。');
        if (fs.existsSync(profiles)) fs.rmdirSync(profiles); // only an empty directory
        fs.renameSync(stage, profiles);
        const legacyConfig = path.join(legacy, 'config.json');
        const config = path.join(userData, 'config.json');
        if (!fs.existsSync(config) && fs.existsSync(legacyConfig)) {
            const parsed = validateConfig(JSON.parse(fs.readFileSync(legacyConfig, 'utf8')));
            atomicWrite(config, JSON.stringify(parsed, null, 2));
        }
        atomicWrite(currentList, JSON.stringify(accounts, null, 2));
        return;
    }
}

module.exports = { JsonStore, atomicWrite, validateId, validateAccounts, validateConfig, profilePath, migrateLegacyData };
