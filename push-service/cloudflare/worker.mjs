import { DurableObject } from 'cloudflare:workers';
import protocol from '../../lib/update-protocol.js';
const { validVersion, compareVersions } = protocol;
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });

async function authorized(request, secret) {
    if (!secret || secret.length < 32) return false;
    const encoder = new TextEncoder();
    const digest = value => crypto.subtle.digest('SHA-256', encoder.encode(value));
    const [left, right] = await Promise.all([digest(request.headers.get('Authorization') || ''), digest('Bearer ' + secret)]);
    const a = new Uint8Array(left), b = new Uint8Array(right);
    let difference = 0; for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
    return difference === 0;
}
async function readPublication(request) {
    if ((request.headers.get('Content-Type') || '').split(';')[0] !== 'application/json') throw Error('JSON required');
    const reader = request.body?.getReader(); if (!reader) throw Error('Body required');
    let size = 0; const parts = [];
    for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); throw Error('Body too large'); }
        parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || Array.isArray(value) || Object.keys(value).join(',') !== 'version' || !validVersion(value.version)) throw Error('Expected only a stable version');
    return value;
}
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'yt-browser-push', protocol: 'websocket-v1' });
        if (url.pathname === '/publish' || url.pathname === '/status') {
            if (!await authorized(request, env.YT_PUSH_TOKEN)) return json({ error: 'Unauthorized' }, 401);
            if (!((url.pathname === '/publish' && request.method === 'POST') || (url.pathname === '/status' && request.method === 'GET'))) return json({ error: 'Method not allowed' }, 405);
        } else if (url.pathname === '/events' && request.method === 'GET') {
            if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426);
            if (!validVersion(url.searchParams.get('version'))) return json({ error: 'Invalid client version' }, 400);
        } else return json({ error: 'Not found' }, 404);
        const hub = env.RELEASE_HUB.get(env.RELEASE_HUB.idFromName('windows-x64-stable-v1'));
        return hub.fetch(request);
    }
};

export class ReleaseHub extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // Idle connections and ping/pong do not keep an object executing.
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/status') return json({ latest: await this.ctx.storage.get('latest') || null, connections: this.ctx.getWebSockets().length });
        if (url.pathname === '/events') {
            if (this.ctx.getWebSockets().length >= 2000) return json({ error: 'Connection limit' }, 503);
            const version = url.searchParams.get('version');
            const pair = new WebSocketPair(), [client, socket] = Object.values(pair);
            this.ctx.acceptWebSocket(socket);
            socket.serializeAttachment({ version });
            socket.send(JSON.stringify({ type: 'connected' }));
            this.sendRelease(socket, await this.ctx.storage.get('latest'));
            return new Response(null, { status: 101, webSocket: client });
        }
        let value;
        try { value = await readPublication(request); }
        catch (error) { return json({ error: error.message }, 400); }
        const result = await this.ctx.storage.transaction(async storage => {
            const latest = await storage.get('latest');
            const order = latest ? compareVersions(value.version, latest.version) : 1;
            if (order < 0) return { error: 'Cannot publish an older version', status: 409 };
            if (order === 0) return { ok: true, duplicate: true, release: latest, status: 200 };
            const release = { id: crypto.randomUUID(), version: value.version, publishedAt: new Date().toISOString() };
            await storage.put('latest', release);
            return { ok: true, release, status: 201 };
        });
        if (result.ok && !result.duplicate) for (const socket of this.ctx.getWebSockets()) this.sendRelease(socket, result.release);
        const { status, ...body } = result; return json(body, status);
    }
    sendRelease(socket, release) {
        if (!release) return;
        try {
            const version = socket.deserializeAttachment()?.version;
            if (validVersion(version) && compareVersions(release.version, version) > 0) socket.send(JSON.stringify({ type: 'release', release }));
        } catch { try { socket.close(1011, 'Reconnect for latest release'); } catch { /* closed */ } }
    }
    webSocketMessage(socket) { socket.close(1008, 'Only heartbeat messages are accepted'); }
    webSocketClose(socket) { try { socket.close(1000, 'Disconnected'); } catch { /* already closed */ } }
    webSocketError(socket) { try { socket.close(1011, 'Reconnect'); } catch { /* already closed */ } }
}
