'use strict';
const { validVersion, validRelease } = require('./update-protocol');
function safeWebSocketURL(value) {
    const url = new URL(value);
    if ((url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) || url.username || url.password || url.hash) {
        throw Error('Push WebSocket requires WSS (WS is only allowed on loopback)');
    }
    return url;
}
class UpdateWebSocketClient {
    constructor({ url, version, onRelease, onConnection = () => {}, WebSocketClass = WebSocket, reconnectBase = 1000 }) {
        this.url = safeWebSocketURL(url);
        if (!validVersion(version)) throw Error('Invalid client version');
        this.url.searchParams.set('version', version);
        Object.assign(this, { onRelease, onConnection, WebSocketClass, reconnectBase });
        this.stopped = true; this.failures = 0; this.retry = null; this.disconnect = null;
    }
    start() { if (this.stopped) { this.stopped = false; this.connect(); } }
    connect() {
        if (this.stopped) return;
        this.onConnection('connecting');
        const socket = new this.WebSocketClass(this.url.href);
        let ended = false, heartbeat, lastMessage = Date.now();
        const timeout = setTimeout(() => disconnected(), 15_000); timeout.unref?.();
        const disconnected = () => {
            if (ended) return;
            ended = true; clearTimeout(timeout); clearInterval(heartbeat);
            try { socket.close(); } catch { /* already closed */ }
            if (this.stopped) return;
            this.onConnection('reconnecting');
            const delay = Math.min(60_000, this.reconnectBase * 2 ** Math.min(this.failures++, 6));
            this.retry = setTimeout(() => { this.retry = null; this.connect(); }, delay); this.retry.unref?.();
        };
        this.disconnect = disconnected;
        socket.addEventListener('open', () => {
            if (ended || this.stopped) return disconnected();
            clearTimeout(timeout); this.onConnection('connected');
            heartbeat = setInterval(() => {
                if (Date.now() - lastMessage > 75_000) return disconnected();
                try { socket.send('ping'); } catch { disconnected(); }
            }, 25_000); heartbeat.unref?.();
        });
        socket.addEventListener('message', event => {
            if (ended || this.stopped) return;
            try {
                if (typeof event.data !== 'string' || event.data.length > 8192) throw Error('Invalid push message');
                if (event.data !== 'pong') {
                    const message = JSON.parse(event.data);
                    if (message.type === 'release' && validRelease(message.release)) this.onRelease(message.release);
                    else if (message.type !== 'connected') throw Error('Invalid release notification');
                }
                lastMessage = Date.now(); this.failures = 0;
            } catch { disconnected(); }
        });
        socket.addEventListener('error', disconnected); socket.addEventListener('close', disconnected);
    }
    resume() { if (!this.stopped) this.disconnect?.(); }
    stop() { this.stopped = true; clearTimeout(this.retry); this.retry = null; this.disconnect?.(); }
}
module.exports = { UpdateWebSocketClient, safeWebSocketURL };
