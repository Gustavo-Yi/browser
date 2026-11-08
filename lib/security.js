'use strict';
function trustedSender(event, webContents, entryURL) {
    return event.sender === webContents && event.senderFrame === webContents.mainFrame && event.senderFrame?.url === entryURL;
}
function protectWindow(win, entryURL) {
    const contents = win.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => { if (url !== entryURL) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    contents.session.setPermissionCheckHandler(() => false);
}
module.exports = { trustedSender, protectWindow };
