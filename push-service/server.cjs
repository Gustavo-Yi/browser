'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, timingSafeEqual } = require('node:crypto');
const { validVersion, validRelease, compareVersions } = require('../lib/update-protocol');

function createPushService({ dataDir, token, heartbeatMs = 25_000, maxClients = 2000 }) {
    if (typeof token !== 'string' || token.length < 32) throw Error('Publisher token must contain at least 32 characters');
    fs.mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, 'latest-release.json');
    let latest = null;
    if (fs.existsSync(stateFile)) {
        latest = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (!validRelease(latest)) throw Error('Invalid persisted release; refusing to lose publication history');
    }
    const clients = new Map();
    const auth = Buffer.from('Bearer ' + token);
    function reply(res, code, data) {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
    }
    function send(res, release, version) {
        if (!release || compareVersions(release.version, version) <= 0) return;
        // Bound slow-reader memory; reconnect will replay the latest release.
        if (res.writableLength > 64 * 1024) { res.destroy(); return; }
        res.write(`id: ${release.id}\nevent: release\ndata: ${JSON.stringify(release)}\n\n`);
    }
    const server = http.createServer((req, res) => {
        let url;
        try { url = new URL(req.url, 'http://localhost'); }
        catch { return reply(res, 400, { error: 'Invalid request URL' }); }
        if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true });
        if (req.method === 'GET' && url.pathname === '/events') {
            const version = url.searchParams.get('version');
            if (!validVersion(version)) return reply(res, 400, { error: 'Invalid client version' });
            if (clients.size >= maxClients) return reply(res, 503, { error: 'Connection limit reached' });
            res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
            res.write(': connected\n\n');
            clients.set(res, version);
            res.on('close', () => clients.delete(res));
            res.on('error', () => { clients.delete(res); res.destroy(); });
            // Always replay the latest release on connection, even with Last-Event-ID:
            // receipt of an event is not proof that the client installed that version.
            send(res, latest, version);
            return;
        }
        if (req.method !== 'POST' || url.pathname !== '/publish') return reply(res, 404, { error: 'Not found' });
        const provided = Buffer.from(req.headers.authorization || '');
        if (provided.length !== auth.length || !timingSafeEqual(provided, auth)) return reply(res, 401, { error: 'Unauthorized' });
        if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') return reply(res, 415, { error: 'JSON required' });
        let body = '', size = 0, rejected = false;
        req.setTimeout(10_000, () => req.destroy());
        req.on('data', chunk => {
            size += chunk.length;
            if (size > 4096) { if (!rejected) reply(res, 413, { error: 'Body too large' }); rejected = true; return; }
            body += chunk.toString('utf8');
        });
        req.on('error', () => { if (!res.writableEnded) res.destroy(); });
        req.on('end', () => {
            if (rejected) return;
            let value;
            try { value = JSON.parse(body); } catch { return reply(res, 400, { error: 'Invalid JSON' }); }
            if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'version' || !validVersion(value.version)) {
                return reply(res, 400, { error: 'Expected only a stable version, e.g. {"version":"2.2.16"}' });
            }
            const order = latest ? compareVersions(value.version, latest.version) : 1;
            if (order < 0) return reply(res, 409, { error: 'Cannot publish an older version' });
            if (order === 0) return reply(res, 200, { ok: true, duplicate: true, release: latest });
            const release = { id: randomUUID(), version: value.version, publishedAt: new Date().toISOString() };
            const temporary = stateFile + '.' + randomUUID() + '.tmp';
            try {
                // Persist BEFORE broadcasting or acknowledging publication. Synchronous
                // atomic replacement also serializes concurrent publication requests.
                fs.writeFileSync(temporary, JSON.stringify(release, null, 2), { flag: 'wx', mode: 0o600, flush: true });
                fs.renameSync(temporary, stateFile);
            } catch {
                try { fs.unlinkSync(temporary); } catch { /* no partial publication */ }
                return reply(res, 500, { error: 'Could not persist release' });
            }
            latest = release;
            for (const [client, version] of clients) send(client, latest, version);
            reply(res, 201, { ok: true, release: latest });
        });
    });
    server.headersTimeout = 15_000;
    const heartbeat = setInterval(() => {
        for (const res of clients.keys()) {
            if (res.writableLength > 64 * 1024) res.destroy();
            else res.write(': heartbeat\n\n');
        }
    }, heartbeatMs);
    heartbeat.unref();
    return { server, get clientCount() { return clients.size; }, get latest() { return latest && { ...latest }; },
        async close() {
            clearInterval(heartbeat);
            for (const res of clients.keys()) res.destroy();
            await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}
module.exports = { createPushService };
