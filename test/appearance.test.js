'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = file => import('data:text/javascript;base64,' + fs.readFileSync(path.join(__dirname, '../ui', file)).toString('base64'));

test('appearance preferences have a production-only key and reject malformed values', async () => {
    const m = await load('appearance-model.js');
    assert.equal(m.APPEARANCE_KEY, 'yt-browser.appearance.v1');
    for (const raw of [null, 'oops', '{}', '{"version":1,"mode":"dark","rgb":[256,0,0]}', '{"version":1,"mode":"bad","rgb":[1,2,3]}']) assert.deepEqual(m.parseAppearance(raw), m.defaultAppearance());
    assert.deepEqual(m.parseAppearance('{"version":1,"mode":"dark","rgb":[0,255,100],"accounts":[1]}'), { version: 1, mode: 'dark', rgb: [0,255,100] });
});
test('RGB/HEX round trip and text contrast for light and dark themes', async () => {
    const m = await load('appearance-model.js');
    for (const r of [0,18,99,128,238,255]) for (const g of [0,18,99,128,238,255]) for (const b of [0,18,99,128,238,255]) for (const theme of ['light', 'dark']) {
        const rgb = [r,g,b], p = m.accentPalette(rgb, theme);
        assert.deepEqual(m.fromHex(m.toHex(rgb)), rgb);
        assert.equal(p.fill, m.toHex(rgb));
        assert(m.contrast(rgb, m.fromHex(p.on)) >= 4.5);
        assert(m.contrast(m.fromHex(p.hover), m.fromHex(p.on)) >= 4.5);
        assert(m.contrast(m.fromHex(p.text), theme === 'dark' ? [37,37,40] : [245,245,246]) >= 5);
    }
    assert.equal(m.fromHex('#gg0000'), null);
});
test('production name limits, date compatibility and failed IPC results', async () => {
    const m = await load('client-model.js');
    assert(m.validateName(' ').error); assert(m.validateName('x'.repeat(201)).error);
    assert.equal(m.validateName(' x ').value, 'x');
    assert.equal(m.formatLastUsed('2026/11/08 09:05'), '11/08 09:05');
    assert.equal(m.formatLastUsed('legacy unknown'), 'legacy unknown');
    assert.equal(m.formatLastUsed(''), '尚未启动');
    await assert.rejects(m.checked(Promise.resolve({ok: false, message: '拒绝'})), /拒绝/);
});
test('release copy cleanup and offline security contract remain in production sources', () => {
    const ui = fs.readFileSync(path.join(__dirname, '../ui/App.jsx'), 'utf8') + fs.readFileSync(path.join(__dirname, '../ui/Appearance.jsx'), 'utf8');
    for (const text of ['黑白两种底色','明亮的白色界面','柔和的黑色界面','随系统自动切换','已固定为','当前为浅色模式','当前为深色模式','按钮 · 选中态','文字自动适配对比度','外观设置已记住','独立交互预览','独立数据目录 · 登录状态保留','当前仅演示','重置演示','模拟账号','seedAccounts']) assert(!ui.includes(text), text);
    const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
    assert(html.includes("connect-src 'none'")); assert(!html.includes('unsafe-inline')); assert(!html.includes('https://'));
    assert(ui.includes('api.closeProfile(a.id)')); assert(ui.includes('api.launchProfile(a.id)'));
});
