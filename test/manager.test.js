'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { AccountManager } = require('../lib/account-manager');
const { getProfileArgument, splitCommandLine, samePath } = require('../lib/windows-processes');
const { trustedSender } = require('../lib/security');

function setup(options = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-browser-manager-'));
    const file = path.join(root, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify([{ id: '10001', name: '原环境', lastUsed: '' }]));
    const records = [];
    let nextPid = 900001; let launchCount = 0; let closeCount = 0;
    const processes = {
        async listProcesses() { if (options.listFails) throw Error('CIM unavailable'); return [...records]; },
        async requestClose(record) {
            closeCount++;
            if (options.closeFails) throw Error('access denied');
            const index = records.findIndex(item => item === record); if (index >= 0) records.splice(index, 1);
        }
    };
    const spawnProcess = (_exe, args) => {
        launchCount++;
        const child = new EventEmitter(); child.pid = ++nextPid; child.unref = () => {};
        setImmediate(() => {
            if (options.spawnFails) return child.emit('error', Object.assign(Error('invalid executable'), { code: 'ENOEXEC' }));
            records.push({ pid: child.pid, executable: 'C:\\fixture\\chrome.exe', createdAt: String(child.pid), profile: args[0].slice(16) });
            child.emit('spawn');
        });
        return child;
    };
    const make = () => new AccountManager({ userData: root, processes, spawnProcess, findChrome: () => 'C:\\fixture\\chrome.exe',
        launchTimeout: 100, closeTimeout: 10, pollDelay: 1, log: { warn() {} } });
    return { root, file, records, options, make, get launchCount() { return launchCount; }, get closeCount() { return closeCount; } };
}
test('restart reattaches existing profiles and duplicate launches are skipped', async () => {
    const f = setup(); const first = f.make();
    assert.equal((await first.launchProfile('10001')).ok, true);
    const reopened = f.make(); await reopened.refresh();
    assert.equal(reopened.getState().accounts[0].isRunning, true);
    assert.equal((await reopened.launchProfile('10001')).reason, 'already-running');
    assert.equal(f.launchCount, 1);
    assert.equal((await reopened.closeAllProfiles()).closed, 1);
});
test('failed close retains identity and truthful status; retry works', async () => {
    const f = setup({ closeFails: true }); const manager = f.make();
    await manager.launchProfile('10001');
    const result = await manager.closeAllProfiles();
    assert.equal(result.closed, 0); assert.equal(result.failed, 1);
    assert.equal(manager.getRunningCount(), 1);
    f.options.closeFails = false;
    assert.equal((await manager.closeAllProfiles()).closed, 1);
});

test('single close targets only its environment and is idempotent without changing account bytes', async () => {
    const f = setup(); const manager = f.make();
    manager.addAccounts({ name: '第二个环境' });
    const second = manager.accounts[1].id;
    await manager.launchProfile('10001'); await manager.launchProfile(second);
    const before = fs.readFileSync(f.file, 'utf8');
    assert.equal((await manager.closeProfile('10001')).closed, 1);
    assert.equal(manager.activeProcesses.has(second), true);
    assert.equal((await manager.closeProfile('10001')).closed, 0);
    assert.equal(f.closeCount, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    assert.throws(() => manager.closeProfile('../outside'));
    assert.throws(() => manager.closeProfile('missing'));
    assert.equal((await manager.closeAllProfiles()).closed, 1);
});

test('single close failure retains both running identities; unknown inventory stops it', async () => {
    const f = setup({ closeFails: true }); const manager = f.make();
    manager.addAccounts({ name: '第二个环境' });
    await manager.launchProfile('10001'); await manager.launchProfile(manager.accounts[1].id);
    assert.equal((await manager.closeProfile('10001')).failed, 1);
    assert.equal(manager.getRunningCount(), 2);
    f.options.listFails = true;
    await assert.rejects(manager.closeProfile('10001'), /核对/);
    assert.equal(f.closeCount, 1);
});
test('async spawn error is not success and does not update lastUsed', async () => {
    const f = setup({ spawnFails: true }); const manager = f.make();
    const before = fs.readFileSync(f.file, 'utf8');
    assert.equal((await manager.launchProfile('10001')).ok, false);
    assert.equal(manager.accounts[0].lastUsed, '');
    assert.equal(fs.readFileSync(f.file, 'utf8'), before);
    const batch = await manager.launchAllProfilesInOrder();
    assert.equal(batch.launched, 0); assert.equal(batch.failed, 1);
});
test('launch/close/rename/delete never touch profile Preferences, cookies or storage', async () => {
    const f = setup(); const manager = f.make();
    const data = path.join(f.root, 'profiles', '10001', 'Default'); fs.mkdirSync(data, { recursive: true });
    for (const name of ['Preferences', 'Cookies', 'Local Storage', 'IndexedDB']) fs.writeFileSync(path.join(data, name), 'malformed fixture ' + name);
    const expected = fs.readdirSync(data).map(name => [name, fs.readFileSync(path.join(data, name), 'utf8')]);
    await manager.launchProfile('10001'); await manager.closeAllProfiles();
    manager.updateAccount({ id: '10001', name: '改名' }); await manager.deleteAccount('10001');
    assert.deepEqual(fs.readdirSync(data).map(name => [name, fs.readFileSync(path.join(data, name), 'utf8')]), expected);
});
test('cannot delete a running environment or silently regenerate its ID', async () => {
    const f = setup(); const manager = f.make(); await manager.launchProfile('10001');
    await assert.rejects(manager.deleteAccount('10001'), /先关闭/);
    assert.equal(manager.accounts[0].id, '10001');
});
test('uncertain process inventory fails closed without killing or launching anything', async () => {
    const f = setup({ listFails: true }); const manager = f.make();
    await assert.rejects(manager.launchProfile('10001'), /核对/);
    await assert.rejects(manager.closeAllProfiles(), /核对/);
    assert.equal(f.launchCount, 0); assert.equal(f.closeCount, 0);
    assert.equal(manager.getState().statusKnown, false);
});
test('concurrent launch requests are serialized and only one process is started', async () => {
    const f = setup(); const manager = f.make();
    const results = await Promise.all([manager.launchProfile('10001'), manager.launchProfile('10001')]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(f.launchCount, 1);
});

test('exit gate rejects pending launches and stops the rest of an arbitrary-size batch', async () => {
    const f = setup(); const manager = f.make();
    manager.addAccounts({ prefix: '环境', count: 6 });
    manager.on('launch-progress', () => manager.beginShutdown());
    const batch = await manager.launchAllProfilesInOrder();
    assert.equal(batch.launched, 1); assert.equal(batch.canceled, 6);
    await assert.rejects(manager.launchProfile(manager.accounts[1].id), /正在退出/);
    assert.equal(f.launchCount, 1);
    assert.equal((await manager.closeAllProfiles()).closed, 1);
    manager.cancelShutdown();
    assert.equal((await manager.launchProfile(manager.accounts[1].id)).ok, true);
    await manager.closeAllProfiles();
});

test('queued launch is rejected when shutdown starts before its queue turn', async () => {
    const f = setup(); const manager = f.make();
    const queued = manager.launchProfile('10001'); manager.beginShutdown();
    await assert.rejects(queued, /正在退出/); assert.equal(f.launchCount, 0);
});

test('shutdown includes unlisted environments under the owned root, never outside Chrome', async () => {
    const f = setup(); const manager = f.make();
    f.records.push({ pid: 1, profile: path.join(f.root, 'profiles', 'legacy-unlisted') },
        { pid: 2, profile: path.join(f.root, 'ordinary', 'not-owned') });
    await manager.refresh(); assert.equal(manager.getRunningCount(), 1);
    assert.equal((await manager.closeAllProfiles()).closed, 1);
    assert.equal(f.records.length, 1); assert.equal(f.records[0].pid, 2);
});

test('a process exiting between inventory and guard adoption is reconciled, not an error', async () => {
    const f = setup(); const manager = f.make(); await manager.launchProfile('10001');
    manager.guard = { async adopt() { f.records.length = 0; throw Error('process already gone'); } };
    await manager.refresh(); assert.equal(manager.getRunningCount(), 0); assert.equal(manager.processError, null);
});

test('guard adoption failure for a STILL live identity is never silently ignored', async () => {
    const f = setup(); const manager = f.make(); await manager.launchProfile('10001');
    manager.guard = { async adopt() { throw Error('access denied'); } };
    await assert.rejects(manager.refresh(), /核对/); assert.equal(manager.getState().statusKnown, false);
});

for (const count of [0, 1, 4, 7, 25]) {
    test(`manager closes every one of ${count} environments, not a hard-coded subset`, async () => {
        const f = setup();
        fs.writeFileSync(f.file, JSON.stringify(Array.from({ length: count }, (_, i) => ({ id: 'env-' + i, name: 'Test ' + i }))));
        const manager = f.make();
        for (const account of manager.accounts) await manager.launchProfile(account.id);
        assert.equal(manager.getRunningCount(), count);
        assert.equal((await manager.closeAllProfiles()).closed, count);
        assert.equal(f.records.length, 0); assert.equal(f.closeCount, count);
    });
}
test('bulk create, rename and input validation retain current environment', () => {
    const f = setup(); const manager = f.make();
    assert.equal(manager.addAccounts({ prefix: '测试', count: 3 }).created, 3);
    assert.equal(manager.accounts.length, 4);
    assert.equal(new Set(manager.accounts.map(acc => acc.id)).size, 4);
    assert.equal(manager.accounts[1].name, '测试-01');
    assert.throws(() => manager.addAccounts({ prefix: 'test', count: 201 }));
    assert.throws(() => manager.updateAccount({ id: '../outside', name: 'x' }));
    assert.equal(manager.accounts[0].id, '10001');
});
test('missing list with existing profiles enters protection mode', () => {
    const f = setup(); fs.unlinkSync(f.file); fs.mkdirSync(path.join(f.root, 'profiles', '10001'), { recursive: true });
    const manager = f.make();
    assert.equal(manager.getState().readOnly, true);
    assert.throws(() => manager.addAccounts({ name: 'x' }));
    assert.equal(fs.existsSync(f.file), false);
});
test('Windows command line parser handles quotes and rejects renderer/ambiguous flags', () => {
    const executable = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"';
    const profile = 'C:\\Users\\测试 用户\\profiles\\10001';
    assert.equal(getProfileArgument(executable + ' "--user-data-dir=' + profile + '"'), profile);
    assert.equal(getProfileArgument(executable + ' --user-data-dir="' + profile + '"'), profile);
    assert.equal(getProfileArgument(executable + ' --user-data-dir "' + profile + '"'), profile);
    assert.equal(getProfileArgument(executable + ' --type=renderer --user-data-dir=C:\\temp'), null);
    assert.equal(getProfileArgument(executable + ' --user-data-dir=C:\\a --user-data-dir=C:\\b'), null);
    assert.equal(getProfileArgument(executable + ' --user-data-dir=relative'), null);
    assert.equal(samePath('C:\\Data\\Test\\', 'c:\\data\\test'), true);
    assert.deepEqual(splitCommandLine('chrome.exe "a b" c'), ['chrome.exe', 'a b', 'c']);
});
test('IPC trusts only the exact local main frame, not sibling windows or child frames', () => {
    const frame = { url: 'file:///D:/app/index.html' }; const contents = { mainFrame: frame };
    assert.equal(trustedSender({ sender: contents, senderFrame: frame }, contents, frame.url), true);
    assert.equal(trustedSender({ sender: {}, senderFrame: frame }, contents, frame.url), false);
    assert.equal(trustedSender({ sender: contents, senderFrame: { url: frame.url } }, contents, frame.url), false);
    assert.equal(trustedSender({ sender: contents, senderFrame: frame }, contents, 'https://example.invalid'), false);
});
