'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const http = require('node:http');
const { createPushService } = require('../push-service/server.cjs');
const { UpdatePushClient, ReleaseStreamParser } = require('../lib/update-push-client');
const { UpdateCoordinator, RETRY_DELAYS } = require('../lib/update-coordinator');
const { validVersion, compareVersions, safePushURL } = require('../lib/update-protocol');
const release = version => ({ id: randomUUID(), version, publishedAt: new Date().toISOString() });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    const end = Date.now() + 4000;
    while (Date.now() < end) { if (check()) return; await pause(10); }
    throw Error('Push test timed out');
}
async function startService(t, dataDir) {
    const token = 'test-only-' + randomUUID();
    const service = createPushService({ dataDir: dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-')), token, heartbeatMs: 25 });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${service.server.address().port}`;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await service.close(); } };
    t.after(close);
    return { service, base, close, publish: (body, secret = token) => fetch(base + '/publish', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + secret }, body: JSON.stringify(body)
    }) };
}
function connect(t, base, events, version = '2.2.15') {
    const client = new UpdatePushClient({ url: base + '/events', version, onRelease: event => events.push(event), reconnectBase: 20, random: () => 0.5 });
    client.start(); t.after(() => client.stop()); return client;
}
test('stable version comparison and transport validation reject injected channels/URLs', () => {
    assert.equal(compareVersions('2.10.0', '2.9.99'), 1);
    for (const input of ['v2.2.16', '2.2.16-beta', '2.2.16\n', '02.2.16', '9999999999.0.0', '', null]) assert(!validVersion(input));
    for (const url of ['http://example.com/events', 'file:///x', 'https://user:secret@example.com/events', 'https://example.com/#fragment']) assert.throws(() => safePushURL(url));
    assert.equal(safePushURL('http://127.0.0.1:47321/events').hostname, '127.0.0.1');
});
test('SSE parsing handles UTF-8 string chunk boundaries, CRLF, comments and multiple events', () => {
    const results = [], parser = new ReleaseStreamParser(event => results.push(event));
    const event = release('2.2.16');
    const input = `: heartbeat\r\n\r\nevent: release\r\ndata: ${JSON.stringify(event)}\r\n\r\nevent: ignored\ndata: not-json\n\n`;
    for (const char of input) parser.feed(char);
    assert.deepEqual(results, [event]);
    assert.throws(() => new ReleaseStreamParser(() => {}).feed('x'.repeat(8193)), /size limit/);
    assert.throws(() => new ReleaseStreamParser(() => {}).feed('event: release\ndata: {"url":"https://other"}\n\n'), /Invalid release/);
});
test('live service broadcasts only after authenticated publish, idempotently and durably', async t => {
    const { base, publish, service } = await startService(t);
    const events = []; connect(t, base, events);
    await until(() => service.clientCount === 1);
    await pause(100); assert.equal(events.length, 0, 'heartbeats are not release checks');
    assert.equal((await publish({ version: '2.2.16' }, 'incorrect')).status, 401);
    assert.equal((await publish({ version: '2.2.16', url: 'https://evil.invalid' })).status, 400);
    assert.equal(service.latest, null);
    assert.equal((await publish({ version: '2.2.16' })).status, 201);
    await until(() => events.length === 1);
    assert.equal(events[0].version, '2.2.16');
    assert.equal((await (await publish({ version: '2.2.16' })).json()).duplicate, true);
    assert.equal((await publish({ version: '2.2.14' })).status, 409);
    await pause(60); assert.equal(events.length, 1);
    const latestClient = []; connect(t, base, latestClient, '2.2.16');
    await until(() => service.clientCount === 2); await pause(50); assert.equal(latestClient.length, 0);
    const late = []; connect(t, base, late);
    await until(() => late.length === 1); assert.equal(late[0].id, events[0].id);
});
test('service restart replays persisted release to offline clients; corruption fails closed', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-replay-'));
    const first = await startService(t, dir);
    await first.publish({ version: '2.2.17' }); const id = first.service.latest.id;
    await first.close();
    const second = await startService(t, dir), events = [];
    const client = connect(t, second.base, events);
    await until(() => events.length === 1); assert.equal(events[0].id, id);
    client.resume(); await until(() => events.length === 2); assert.equal(events[1].id, id);
    client.stop(); await until(() => second.service.clientCount === 0);
    fs.writeFileSync(path.join(dir, 'latest-release.json'), 'broken');
    assert.throws(() => createPushService({ dataDir: dir, token: 'x'.repeat(32) }));
});
test('broken SSE transport automatically reconnects and replays without polling metadata', async t => {
    const { service, base, publish } = await startService(t);
    const events = [], client = connect(t, base, events);
    await until(() => service.clientCount === 1);
    await publish({ version: '2.2.16' }); await until(() => events.length === 1);
    service.server.closeAllConnections();
    await until(() => events.length === 2);
    assert.equal(events[0].id, events[1].id);
    client.stop(); await until(() => service.clientCount === 0);
    await pause(100); assert.equal(service.clientCount, 0);
});
test('local startup and publish CLI work without exposing publisher credentials', async t => {
    const probe = http.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-cli-'));
    const token = 'cli-test-' + randomUUID();
    const env = { ...process.env, YT_PUSH_HOST: '127.0.0.1', YT_PUSH_PORT: String(port), YT_PUSH_DATA_DIR: dir,
        YT_PUSH_TOKEN: token, YT_PUSH_URL: `http://127.0.0.1:${port}` };
    const server = spawn(process.execPath, [path.join(__dirname, '../push-service/start.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; server.stdout.on('data', chunk => { output += chunk; }); server.stderr.on('data', chunk => { output += chunk; });
    t.after(() => { if (server.exitCode === null) server.kill(); });
    await until(() => output.includes('Push service listening'));
    const result = await promisify(execFile)(process.execPath, [path.join(__dirname, '../scripts/publish-update.cjs'), '2.2.16'], { env, windowsHide: true });
    assert.equal(JSON.parse(result.stdout).release.version, '2.2.16');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'latest-release.json'))).version, '2.2.16');
    assert(!output.includes(token)); assert(!result.stdout.includes(token));
});
test('concurrent publishes serialize monotonically; failed persistence never broadcasts', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-push-atomic-'));
    const { publish, service, base } = await startService(t, dir);
    const events = []; connect(t, base, events); await until(() => service.clientCount === 1);
    await Promise.all([publish({ version: '2.2.18' }), publish({ version: '2.2.17' })]);
    assert.equal(service.latest.version, '2.2.18');
    await until(() => events.length > 0); const count = events.length;
    fs.renameSync(path.join(dir, 'latest-release.json'), path.join(dir, 'before.json'));
    fs.mkdirSync(path.join(dir, 'latest-release.json'));
    assert.equal((await publish({ version: '2.2.19' })).status, 500);
    await pause(60); assert.equal(events.length, count); assert.equal(service.latest.version, '2.2.18');
});

function fixture(options = {}) {
    const updater = new EventEmitter(), timers = [], states = [];
    let checks = 0, downloads = 0;
    updater.checkForUpdates = async () => { checks++; return options.check ? options.check() : { isUpdateAvailable: true, updateInfo: { version: '2.2.16' } }; };
    updater.downloadUpdate = async () => { downloads++; if (options.download) await options.download(); updater.emit('update-downloaded', { version: '2.2.16' }); return ['fixture.exe']; };
    const controller = new UpdateCoordinator({ updater, version: '2.2.15', enabled: options.enabled ?? true,
        notify: state => states.push(state), log: { warn() {} }, canUpdate: options.canUpdate || (() => true),
        setTimer: (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer; },
        clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); }
    });
    return { controller, updater, timers, states, get checks() { return checks; }, get downloads() { return downloads; } };
}
test('no startup/polling checks; push triggers exactly one verified-download flow and never installs', async () => {
    const f = fixture(); assert.equal(f.checks, 0); assert.equal(f.timers.length, 0);
    f.controller.connection('connected'); assert.equal(f.checks, 0);
    f.controller.receive(release('2.2.14')); assert.equal(f.checks, 0);
    f.controller.receive(release('2.2.16')); await f.controller.inFlight;
    assert.equal(f.checks, 1); assert.equal(f.downloads, 1); assert(f.controller.isReady);
    assert.equal(f.updater.autoInstallOnAppQuit, false); assert.equal(f.updater.autoDownload, false);
    f.controller.receive(release('2.2.16')); f.controller.receive(release('2.2.17'));
    await f.controller.check({ manual: true }); assert.equal(f.checks, 1); assert.equal(f.timers.length, 0);
    f.updater.emit('update-not-available'); f.updater.emit('error', Error('late error'));
    assert(f.controller.isReady); assert.equal(f.controller.getState().version, '2.2.16');
    const snapshot = f.controller.getState(); snapshot.type = 'error'; assert(f.controller.isReady);
});
test('manual check remains independent of push connectivity; concurrent requests share a gate', async () => {
    let resolveDownload;
    const f = fixture({ download: () => new Promise(resolve => { resolveDownload = resolve; }) });
    f.controller.connection('reconnecting');
    const pending = f.controller.check({ manual: true });
    await until(() => !!resolveDownload);
    f.controller.receive(release('2.2.16'));
    await f.controller.check({ manual: true }); assert.equal(f.checks, 1); assert.equal(f.downloads, 1);
    resolveDownload(); await pending; assert(f.controller.isReady);
});
test('notified release failures have bounded retries, never endless version polling', async () => {
    const f = fixture({ check: () => { throw Error('offline'); } });
    f.controller.receive(release('2.2.16')); await f.controller.inFlight;
    for (const delay of RETRY_DELAYS) {
        assert.equal(f.timers.length, 1);
        const timer = f.timers.shift(); assert.equal(timer.delay, delay);
        timer.fn(); await f.controller.inFlight;
    }
    assert.equal(f.checks, 4); assert.equal(f.timers.length, 0); assert.equal(f.controller.getState().type, 'error');
    f.controller.receive(release('2.2.16')); assert.equal(f.checks, 4);
    await f.controller.check({ manual: true }); assert.equal(f.checks, 5);
    f.controller.dispose(); assert.equal(f.timers.length, 0); assert.equal(f.updater.listenerCount('download-progress'), 0);
});
test('publication arriving during a manual no-update check is queued, not lost', async () => {
    let finishFirst, calls = 0;
    const f = fixture({ check: () => ++calls === 1 ? new Promise(resolve => { finishFirst = resolve; }) :
        { isUpdateAvailable: true, updateInfo: { version: '2.2.16' } } });
    const first = f.controller.check({ manual: true });
    await until(() => !!finishFirst);
    f.controller.receive(release('2.2.16'));
    finishFirst({ isUpdateAvailable: false }); await first;
    await until(() => f.controller.isReady);
    assert.equal(f.checks, 2); assert.equal(f.downloads, 1); assert.equal(f.timers.length, 0);
});
test('shutdown between metadata and download never leaves a permanently busy update state', async () => {
    let allowed = true;
    const f = fixture({ canUpdate: () => allowed, check: () => {
        allowed = false; return { isUpdateAvailable: true, updateInfo: { version: '2.2.16' } };
    } });
    await f.controller.check({ manual: true });
    assert.equal(f.downloads, 0); assert.equal(f.controller.getState().type, 'error');
});
test('stale/unavailable release metadata cannot start download or show READY', async () => {
    for (const result of [{ isUpdateAvailable: false }, { isUpdateAvailable: true, updateInfo: { version: '2.2.16' } }]) {
        const f = fixture({ check: () => result });
        f.controller.receive(release('2.2.17')); await f.controller.inFlight;
        assert.equal(f.downloads, 0); assert.equal(f.controller.getState().type, 'error'); f.controller.dispose();
    }
});
test('development mode and shutdown gate never download; no-release manual check does not schedule', async () => {
    const dev = fixture({ enabled: false }); dev.controller.receive(release('2.2.16'));
    await dev.controller.check({ manual: true }); assert.equal(dev.checks, 0); assert.equal(dev.timers.length, 0);
    const quitting = fixture({ canUpdate: () => false }); await quitting.controller.check({ manual: true }); assert.equal(quitting.checks, 0);
    const none = fixture({ check: () => ({ isUpdateAvailable: false }) });
    await none.controller.check({ manual: true }); assert.equal(none.controller.getState().type, 'none'); assert.equal(none.timers.length, 0);
});
test('renderer snapshot merge cannot replace READY with an older IPC response', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../ui/client-model.js'));
    const { newerUpdate } = await import('data:text/javascript;base64,' + source.toString('base64'));
    const ready = { type: 'ready', revision: 4 };
    assert.equal(newerUpdate(ready, { type: 'idle', revision: 1 }), ready);
    assert.equal(newerUpdate(ready, undefined), ready);
    assert.equal(newerUpdate(ready, { type: 'ready', revision: 5 }).revision, 5);
});
