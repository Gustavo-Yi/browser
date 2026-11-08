'use strict';
// Runs the real application with a NEW disposable userData/appData root.
// No installed client data, Chrome profiles, or WhatsApp data are used.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-local-ui-'));
for (const name of ['userData', 'appData']) fs.mkdirSync(path.join(root, name));
app.setPath('userData', path.join(root, 'userData'));
app.setPath('sessionData', path.join(root, 'userData'));
app.setPath('appData', path.join(root, 'appData'));
app.getVersion = () => require('../package.json').version;
// Use the same default hardware acceleration as the packaged client.
fs.writeFileSync(path.join(root, 'userData', 'accounts.json'), JSON.stringify([
    {id:'local-test-01',name:'本地测试环境 01',lastUsed:''},
    {id:'local-test-02',name:'本地测试环境 02',lastUsed:''}
], null, 2));
app.on('browser-window-created', (_event, win) => {
    win.on('page-title-updated', event => event.preventDefault());
    win.webContents.on('did-finish-load', () => {
        win.setTitle('YT多开浏览器 · 本地测试（独立数据目录）');
        win.show(); win.focus();
        console.log('LOCAL_PREVIEW_WINDOW=' + JSON.stringify({ visible: win.isVisible(), bounds: win.getBounds(), title: win.getTitle() }));
    });
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
        if (win.isDestroyed()) return;
        try {
            fs.writeFileSync(path.join(root, 'preview.png'), (await win.webContents.capturePage()).toPNG());
            console.log('LOCAL_PREVIEW_SCREENSHOT=' + path.join(root, 'preview.png'));
        } catch (error) { console.warn('Preview capture:', error.message); }
    }, 3500));
});
console.log('LOCAL_PREVIEW_DATA=' + root);
require('../main.js');
