'use strict';
// Explicit integration check: publishes ONLY the version supplied by the caller.
// In production this must already be an available stable GitHub release.
const assert = require('node:assert/strict');
const { UpdateWebSocketClient } = require('../lib/update-websocket-client');
const { validVersion, safePushURL } = require('../lib/update-protocol');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
    const end = Date.now() + 30_000;
    while (Date.now() < end) { if (fn()) return; await pause(50); }
    throw Error('Timed out waiting for push transport');
}
async function verify(base, version, token, { fetch: fetcher = fetch, WebSocket: Socket = WebSocket } = {}) {
    safePushURL(base); assert(validVersion(version)); assert(token?.length >= 32);
    const events = [], states = [], clients = [], sockets = [], checks = [];
    const wsURL = new URL('/events', base); wsURL.protocol = wsURL.protocol === 'https:' ? 'wss:' : 'ws:';
    const post = (value, auth = token) => fetcher(new URL('/publish', base).href, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth }, body: JSON.stringify(value), signal: AbortSignal.timeout(20_000) });
    try {
        const health = await (await fetcher(new URL('/health', base).href, { signal: AbortSignal.timeout(20_000) })).json();
        assert.equal(health.protocol, 'websocket-v1'); checks.push('health / WebSocket protocol');
        assert.equal((await post({ version }, 'invalid')).status, 401); checks.push('unauthorized publication rejected');
        assert.equal((await post({ version, url: 'https://invalid.example/package.exe' })).status, 400); checks.push('download URL injection rejected');
        const client = new UpdateWebSocketClient({ url: wsURL.href, version: '0.0.0', WebSocketClass: Socket, onRelease: e => events.push(e), onConnection: s => states.push(s), reconnectBase: 250 });
        clients.push(client); client.start(); await until(() => states.includes('connected'));
        const published = await post({ version }); assert([200, 201].includes(published.status));
        const result = await published.json(); await until(() => events.some(e => e.id === result.release.id));
        checks.push('authenticated publication reaches real client');
        const count = events.length;
        const duplicate = await (await post({ version })).json(); assert(duplicate.duplicate);
        await pause(300); assert.equal(events.length, count); checks.push('duplicate publication is idempotent');
        client.resume(); await until(() => events.length > count); assert.equal(events.at(-1).id, result.release.id);
        checks.push('reconnect replays durable release');
        const currentEvents = [], currentStates = [];
        const current = new UpdateWebSocketClient({ url: wsURL.href, version, WebSocketClass: Socket, onRelease: e => currentEvents.push(e), onConnection: s => currentStates.push(s) });
        clients.push(current); current.start(); await until(() => currentStates.includes('connected'));
        await pause(300); assert.equal(currentEvents.length, 0); checks.push('current version is not offered its own update');
        const pingURL = new URL(wsURL); pingURL.searchParams.set('version', version);
        const ping = new Socket(pingURL.href); sockets.push(ping); let pong = false;
        ping.addEventListener('open', () => ping.send('ping'));
        ping.addEventListener('message', e => { if (e.data === 'pong') pong = true; });
        ping.addEventListener('error', () => {}); await until(() => pong); checks.push('hibernation-compatible heartbeat');
        const status = await (await fetcher(new URL('/status', base).href, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20_000) })).json();
        assert.equal(status.latest.id, result.release.id); checks.push('authoritative durable state matches publication');
        return { passed: true, base, version, release: result.release, checks };
    } finally { clients.forEach(c => c.stop()); sockets.forEach(s => s.close()); }
}
if (require.main === module) verify(process.env.YT_PUSH_URL, process.argv[2], process.env.YT_PUSH_TOKEN)
    .then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { verify };
