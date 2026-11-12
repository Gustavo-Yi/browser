'use strict';

// This project publishes stable Windows x64 releases (not prerelease channels).
function validVersion(value) {
    return typeof value === 'string' && /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(value);
}
function compareVersions(a, b) {
    if (!validVersion(a) || !validVersion(b)) throw Error('Invalid stable version');
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
    return 0;
}
function validRelease(value) {
    return value && typeof value === 'object' && !Array.isArray(value) &&
        Object.keys(value).every(key => ['id', 'version', 'publishedAt'].includes(key)) &&
        typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id) &&
        validVersion(value.version) && typeof value.publishedAt === 'string' &&
        Number.isFinite(Date.parse(value.publishedAt));
}
function safePushURL(value) {
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.hash) {
        throw Error('Push URL requires HTTPS (HTTP is only allowed on loopback)');
    }
    return url;
}
module.exports = { validVersion, compareVersions, validRelease, safePushURL };
