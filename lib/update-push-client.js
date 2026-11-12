'use strict';
const http = require('node:http'), https = require('node:https');
const { safePushURL, validRelease, validVersion } = require('./update-protocol');

// A small bounded SSE reader for our UTF-8 release stream (not renderer JS).
class ReleaseStreamParser {
    constructor(onRelease) { this.onRelease = onRelease; this.buffer = ''; this.data = []; this.event = ''; this.size = 0; }
    feed(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, index).replace(/\r$/, '');
            this.buffer = this.buffer.slice(index + 1);
            this.size += line.length;
            if (this.size > 8192) throw Error('Push event exceeds size limit');
            if (!line) {
                if (this.event === 'release' && this.data.length) {
                    const value = JSON.parse(this.data.join('\n'));
                    if (!validRelease(value)) throw Error('Invalid release notification');
                    this.onRelease(value);
                }
                this.event = ''; this.data = []; this.size = 0;
            } else if (!line.startsWith(':')) {
                const colon = line.indexOf(':');
                const field = colon < 0 ? line : line.slice(0, colon);
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                if (field === 'event') this.event = value;
                if (field === 'data') this.data.push(value);
            }
        }
        if (this.buffer.length + this.size > 8192) throw Error('Push event exceeds size limit');
    }
}
class UpdatePushClient {
    constructor({ url, version, onRelease, onConnection = () => {}, reconnectBase = 1000, random = Math.random }) {
        this.url = safePushURL(url);
        if (!validVersion(version)) throw Error('Invalid client version');
        this.url.searchParams.set('version', version);
        Object.assign(this, { onRelease, onConnection, reconnectBase, random });
        this.stopped = true; this.failures = 0; this.timer = null; this.request = null; this.disconnect = null;
    }
    start() { if (this.stopped) { this.stopped = false; this.connect(); } }
    connect() {
        if (this.stopped) return;
        this.onConnection('connecting');
        let ended = false, response, connectTimer;
        const parser = new ReleaseStreamParser(release => this.onRelease(release));
        const req = (this.url.protocol === 'https:' ? https : http).get(this.url, {
            headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' }, agent: false
        });
        this.request = req;
        const disconnected = () => {
            if (ended) return;
            ended = true; clearTimeout(connectTimer); response?.destroy(); req.destroy();
            if (this.request === req) this.request = null;
            if (this.stopped) return;
            this.onConnection('reconnecting');
            // These timers reconnect the transport; they NEVER query release metadata.
            const delay = Math.round(Math.min(60_000, this.reconnectBase * 2 ** Math.min(this.failures++, 6) * (0.8 + this.random() * 0.4)));
            this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
            this.timer.unref?.();
        };
        this.disconnect = disconnected;
        connectTimer = setTimeout(disconnected, 15_000); connectTimer.unref?.();
        req.setTimeout(75_000, disconnected);
        req.on('error', disconnected);
        req.on('response', res => {
            if (ended || this.stopped) { res.destroy(); return; }
            response = res;
            if (res.statusCode !== 200 || !/^text\/event-stream(?:;|$)/i.test(res.headers['content-type'] || '')) return disconnected();
            clearTimeout(connectTimer);
            this.onConnection('connected');
            res.setEncoding('utf8');
            res.on('data', chunk => {
                if (ended || this.stopped) return;
                try { parser.feed(chunk); this.failures = 0; } catch { disconnected(); }
            });
            res.on('end', disconnected); res.on('error', disconnected); res.on('close', disconnected);
        });
    }
    resume() {
        if (this.stopped) return;
        // Reconnect after OS resume so the server can replay a missed publication.
        this.disconnect?.();
    }
    stop() {
        this.stopped = true; clearTimeout(this.timer); this.timer = null;
        this.disconnect?.(); this.request?.destroy(); this.request = null;
    }
}
module.exports = { UpdatePushClient, ReleaseStreamParser };
