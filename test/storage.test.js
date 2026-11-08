'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore, validateAccounts, validateConfig, validateId, profilePath, migrateLegacyData } = require('../lib/storage');
const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yt-browser-storage-'));
const account = [{ id: '10001', name: '旧环境', lastUsed: '' }];

test('reading legacy records preserves exact file bytes, IDs and extra fields', () => {
    const file = path.join(fixture(), 'accounts.json');
    const raw = '[{"id":10001,"name":"旧环境","custom":"preserved"}]';
    fs.writeFileSync(file, raw);
    const store = new JsonStore(file, validateAccounts, []);
    assert.equal(store.value[0].id, '10001');
    assert.equal(store.value[0].custom, 'preserved');
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
    assert.equal(fs.existsSync(file + '.bak'), false);
});
test('malformed, wrong-shape and duplicate lists remain untouched and read-only', () => {
    for (const raw of ['[{"id":"10001"', '{}', '[null]', '[{"id":"a","name":"x"},{"id":"a","name":"y"}]']) {
        const file = path.join(fixture(), 'accounts.json');
        fs.writeFileSync(file, raw);
        const store = new JsonStore(file, validateAccounts, []);
        assert(store.error);
        assert.throws(() => store.save([]));
        assert.equal(fs.readFileSync(file, 'utf8'), raw);
    }
});
test('corrupt or missing primary may display a backup but cannot overwrite either', () => {
    for (const missing of [true, false]) {
        const file = path.join(fixture(), 'accounts.json');
        if (!missing) fs.writeFileSync(file, 'broken');
        const backup = JSON.stringify(account);
        fs.writeFileSync(file + '.bak', backup);
        const store = new JsonStore(file, validateAccounts, []);
        assert.equal(store.value[0].id, '10001'); assert(store.error);
        assert.throws(() => store.save([]));
        assert.equal(fs.readFileSync(file + '.bak', 'utf8'), backup);
        assert.equal(fs.existsSync(file), !missing);
    }
});
test('successful changes back up prior valid bytes and retain IDs', () => {
    const file = path.join(fixture(), 'accounts.json');
    const before = JSON.stringify(account);
    fs.writeFileSync(file, before);
    const store = new JsonStore(file, validateAccounts, []);
    store.save([{ ...account[0], name: '新名称' }]);
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), before);
    assert.equal(JSON.parse(fs.readFileSync(file))[0].id, '10001');
    assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['accounts.json', 'accounts.json.bak']);
});
test('failed final rename never truncates original or commits in-memory state', () => {
    const file = path.join(fixture(), 'accounts.json');
    const before = JSON.stringify(account); fs.writeFileSync(file, before);
    const io = Object.create(fs);
    io.renameSync = (a, b) => { if (b === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.renameSync(a, b); };
    const store = new JsonStore(file, validateAccounts, [], io);
    assert.throws(() => store.save([]), /denied/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(store.value.length, 1);
});
test('external edits and invalid config are never overwritten', () => {
    const file = path.join(fixture(), 'config.json');
    fs.writeFileSync(file, '{"chromePath":""}');
    const store = new JsonStore(file, validateConfig, {});
    fs.writeFileSync(file, 'broken');
    assert.throws(() => store.save({ chromePath: '' }), /其他程序/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
    assert(new JsonStore(file, validateConfig, {}).error);
});
test('IDs cannot escape profiles or name Windows device files', () => {
    for (const id of ['..', '..\\outside', '../outside', 'C:\\tmp', '\\\\server\\share', 'a:b', 'x.', 'NUL', 'COM1', '', null]) {
        assert.throws(() => validateId(id));
    }
    assert.equal(validateId('1700000000000001'), '1700000000000001');
    assert.equal(validateId('old-UUID_1'), 'old-UUID_1');
});
test('external directory junction is rejected', { skip: process.platform !== 'win32' }, () => {
    const root = fixture(); const profiles = path.join(root, 'profiles'); const outside = path.join(root, 'outside');
    fs.mkdirSync(profiles); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(profiles, '123'), 'junction');
    assert.throws(() => profilePath(profiles, '123'), /允许范围/);
    assert.deepEqual(fs.readdirSync(outside), []);
});
test('legacy migration never overwrites an empty or corrupt current list', async () => {
    for (const raw of ['[]', 'broken']) {
        const root = fixture(); const legacy = path.join(root, 'old'); const current = path.join(root, 'new');
        fs.mkdirSync(legacy); fs.mkdirSync(current);
        fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify(account));
        fs.writeFileSync(path.join(current, 'accounts.json'), raw);
        await migrateLegacyData(current, [legacy], async () => []);
        assert.equal(fs.readFileSync(path.join(current, 'accounts.json'), 'utf8'), raw);
    }
});
test('legacy migration refuses active profiles, then copies inactive ones without changing originals', async () => {
    const root = fixture(); const legacy = path.join(root, 'old'); const current = path.join(root, 'new');
    const data = path.join(legacy, 'profiles', '10001', 'Default'); fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'Cookies'), 'fixture-cookie-bytes');
    fs.writeFileSync(path.join(legacy, 'accounts.json'), JSON.stringify(account));
    await assert.rejects(migrateLegacyData(current, [legacy], async () => [{}]), /仍在运行/);
    assert.equal(fs.existsSync(path.join(current, 'accounts.json')), false);
    await migrateLegacyData(current, [legacy], async () => []);
    assert.equal(fs.readFileSync(path.join(current, 'profiles', '10001', 'Default', 'Cookies'), 'utf8'), 'fixture-cookie-bytes');
    assert.equal(fs.readFileSync(path.join(data, 'Cookies'), 'utf8'), 'fixture-cookie-bytes');
});
