'use strict';
// Real Chrome; only new disposable profiles. Never reads user account profiles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { AccountManager, findChromePath } = require('../lib/account-manager');
const windows = require('../lib/windows-processes');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-chrome-测试 '));
const profiles = path.join(root, 'profiles');
const chrome = findChromePath({});
if (!chrome) throw Error('Chrome is required for this integration test.');
const accounts = ['10001', '20002'].map(id => ({ id, name: 'Fixture ' + id, lastUsed: '' }));
fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify(accounts));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = [];
let server;

async function waitFor(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch { /* wait for Chrome */ }
        await pause(150);
    }
    throw Error('Timed out waiting for test Chrome');
}
async function cdp(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (!pending.has(message.id)) return;
        const { resolve, reject, timer } = pending.get(message.id);
        clearTimeout(timer); pending.delete(message.id);
        message.error ? reject(Error(message.error.message)) : resolve(message.result);
    });
    const client = {
        socket,
        call(method, params = {}) {
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 10000);
                pending.set(id, { resolve, reject, timer });
                socket.send(JSON.stringify({ id, method, params }));
            });
        },
        async evaluate(expression) {
            const value = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            if (value.exceptionDetails) throw Error(JSON.stringify(value.exceptionDetails));
            return value.result.value;
        }
    };
    clients.push(client); return client;
}
async function endpoint(id) {
    return waitFor(() => {
        const lines = fs.readFileSync(path.join(profiles, id, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
        return { port: Number(lines[0]), browser: 'ws://127.0.0.1:' + lines[0] + lines[1] };
    });
}
async function page(id, origin) {
    const ep = await endpoint(id);
    const tab = await waitFor(async () => {
        const tabs = await (await fetch('http://127.0.0.1:' + ep.port + '/json')).json();
        return tabs.find(tab => tab.type === 'page' && tab.url.startsWith(origin));
    });
    return cdp(tab.webSocketDebuggerUrl);
}

(async () => {
    server = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end('<!doctype html><title>YT isolated regression</title><p>Disposable test profile. No WhatsApp account.</p>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const makeManager = () => new AccountManager({
        userData: root, findChrome: () => chrome, launchTimeout: 20000, closeTimeout: 10000,
        spawnProcess(exe, args, options) {
            return spawn(exe, [...args.filter(arg => arg !== '--start-maximized'),
                '--window-position=-32000,-32000', '--window-size=800,600', '--start-minimized',
                '--disable-gpu', '--disable-background-networking', '--disable-component-update',
                '--disable-sync', '--remote-debugging-port=0', origin], options);
        }
    });
    let manager = makeManager();
    for (const account of accounts) assert.equal((await manager.launchProfile(account.id)).ok, true);
    assert.equal(manager.getRunningCount(), 2);
    for (const account of accounts) {
        const client = await page(account.id, origin);
        await client.evaluate('document.cookie="fixtureLogin=' + account.id + '; Max-Age=86400; Path=/; SameSite=Lax"; localStorage.setItem("fixtureLogin","' + account.id + '");');
        await client.evaluate('new Promise((resolve,reject)=>{const r=indexedDB.open("login-fixture",1);r.onupgradeneeded=()=>r.result.createObjectStore("state");r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const tx=db.transaction("state","readwrite");tx.objectStore("state").put("' + account.id + '","session");tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})');
    }
    manager = makeManager(); // Client reopened; same untouched account IDs/directories.
    await manager.refresh(); assert.equal(manager.getRunningCount(), 2);
    const liveRecords = await windows.listProcesses(profiles);
    await assert.rejects(windows.requestClose({ ...liveRecords[0], createdAt: 'not-the-same-process' }));
    assert.equal((await windows.listProcesses(profiles)).length, 2, 'Identity mismatch must not close any browser');
    assert.equal((await manager.launchProfile('10001')).reason, 'already-running');
    const oneClosed = await manager.closeProfile('10001');
    assert.equal(oneClosed.closed, 1); assert.equal(oneClosed.failed, 0);
    assert.equal(manager.getRunningCount(), 1);
    assert.equal(manager.activeProcesses.has('20002'), true, 'Single close must not touch the other environment');
    const survivor = await page('20002', origin);
    assert.equal(await survivor.evaluate('localStorage.getItem("fixtureLogin")'), '20002');
    assert.equal((await manager.launchProfile('10001')).ok, true);
    const reopenedOne = await page('10001', origin);
    assert((await reopenedOne.evaluate('document.cookie')).includes('fixtureLogin=10001'));
    const closed = await manager.closeAllProfiles();
    assert.equal(closed.failed, 0, 'Production graceful close must exit fixture Chrome: ' + JSON.stringify(closed));
    assert.equal(closed.closed, 2);
    assert.equal((await windows.listProcesses(profiles)).length, 0);
    for (const account of accounts) {
        assert.equal((await manager.launchProfile(account.id)).ok, true);
        const client = await page(account.id, origin);
        const saved = await client.evaluate('({cookie:document.cookie,local:localStorage.getItem("fixtureLogin")})');
        assert(saved.cookie.includes('fixtureLogin=' + account.id)); assert.equal(saved.local, account.id);
        const indexed = await client.evaluate('new Promise((resolve,reject)=>{const r=indexedDB.open("login-fixture",1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;const read=db.transaction("state").objectStore("state").get("session");read.onsuccess=()=>{db.close();resolve(read.result)};read.onerror=()=>reject(read.error)}})');
        assert.equal(indexed, account.id);
    }
    const final = await manager.closeAllProfiles(); assert.equal(final.closed, 2); assert.equal(final.failed, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'))).map(x => x.id), ['10001', '20002']);
    const result = { passed: true, root, chrome, profiles: 2, singleCloseIsolation: true, gracefulClose: true, restartReattach: true, pidIdentityGuard: true, persistentCookie: true, localStorage: true, indexedDB: true };
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
})().catch(error => {
    console.error(error.stack, root); fs.writeFileSync(path.join(root, 'error.txt'), error.stack); process.exitCode = 1;
}).finally(async () => {
    // Cleanup uses only loopback debugging endpoints in our newly-created profiles.
    for (const account of accounts) {
        try {
            const ep = await endpoint(account.id);
            const client = await cdp(ep.browser);
            await client.call('Browser.close');
        } catch { /* Already closed. */ }
    }
    for (const client of clients) client.socket.close();
    if (server) server.close();
});
