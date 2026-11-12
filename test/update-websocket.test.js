'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { UpdateWebSocketClient, safeWebSocketURL } = require('../lib/update-websocket-client');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
class Socket extends EventTarget {
    static instances = [];
    constructor(url) { super(); this.url = url; Socket.instances.push(this); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    close() { this.closed = true; }
    message(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
}
test('WebSocket endpoint requires TLS outside loopback and never accepts credentials', () => {
    for (const url of ['ws://example.com/events', 'wss://u:p@example.com/events', 'https://example.com/events', 'wss://example.com/#x']) assert.throws(() => safeWebSocketURL(url));
    assert.equal(safeWebSocketURL('wss://example.com/events').protocol, 'wss:');
});
test('WebSocket transport forwards only validated release notifications and stops reconnecting on dispose', async () => {
    const events = [], states = [];
    const client = new UpdateWebSocketClient({ url: 'ws://localhost:8080/events', version: '2.2.15', WebSocketClass: Socket,
        onRelease: event => events.push(event), onConnection: s => states.push(s), reconnectBase: 10 });
    client.start(); await pause(1); const first = Socket.instances.at(-1);
    assert.equal(new URL(first.url).searchParams.get('version'), '2.2.15');
    first.message('{"type":"connected"}'); first.message('pong'); assert.equal(events.length, 0);
    const release = { id: '11111111-1111-1111-1111-111111111111', version: '2.2.16', publishedAt: new Date().toISOString() };
    first.message(JSON.stringify({ type: 'release', release })); assert.deepEqual(events, [release]);
    first.message(JSON.stringify({ type: 'release', release: { ...release, url: 'https://invalid' } }));
    assert(first.closed); await pause(25); assert.notEqual(Socket.instances.at(-1), first);
    const count = Socket.instances.length; client.stop(); await pause(25);
    assert.equal(Socket.instances.length, count); assert(states.includes('reconnecting'));
});
