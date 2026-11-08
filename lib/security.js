'use strict';
function sameEntryURL(url, entryURL) {
    if (typeof url !== 'string' || typeof entryURL !== 'string' ||
        !url.startsWith('file:///') || !entryURL.startsWith('file:///')) return false;
    // Node's pathToFileURL encodes '~' while Chromium can leave it literal.
    // Normalize only unreserved characters, never separators, query/fragment
    // delimiters or double encoding. The exact local entry remains the boundary.
    const normalize = value => value.replace(/%([0-9a-f]{2})/gi, (encoded, hex) => {
        const char = String.fromCharCode(parseInt(hex,16));
        return /^[A-Za-z0-9._~-]$/.test(char) ? char : encoded.toUpperCase();
    });
    return normalize(url) === normalize(entryURL);
}
function trustedSender(event, webContents, entryURL) {
    return event.sender === webContents && event.senderFrame === webContents.mainFrame && sameEntryURL(event.senderFrame?.url, entryURL);
}
function protectWindow(win, entryURL) {
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (!sameEntryURL(url, entryURL)) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
}
module.exports = { trustedSender, protectWindow };
