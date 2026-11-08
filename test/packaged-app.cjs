'use strict';
// Extract and run the EXACT installer payload without installing into Windows.
// No installer registry entries/shortcuts, no default userData, no real WhatsApp data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const resedit = require('resedit');
const { listProcesses } = require('../lib/windows-processes');
const { AccountManager } = require('../lib/account-manager');
const repo = path.join(__dirname, '..');
const pkg = require('../package.json');
const installer = path.resolve(process.argv[2] || path.join(repo, 'dist-local', `${pkg.productName} Setup ${pkg.version}.exe`));
// Exercise the same tilde encoding mismatch observed after a real NSIS install.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-packaged~test-'));
const application = path.join(root, 'application'), userData = path.join(root, 'userData');
const accountsFile = path.join(userData, 'accounts.json');
const profiles = path.join(userData, 'profiles');
const checks = [], sockets = [], logs = [];
let child, page, browser, exited;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const check = (label, condition) => { assert(condition, label); checks.push(label); console.log('PASS ' + label); };
async function until(fn, timeout = 40000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const result = await fn(); if (result) return result; await pause(100); }
    throw Error('Timed out waiting for packaged app');
}
async function connect(url) {
    assert(url.startsWith('ws://127.0.0.1:'), 'Test debugger must be loopback-only');
    const socket = new WebSocket(url); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once:true }); socket.addEventListener('error', reject, { once:true }); });
    let seq = 0; const pending = new Map();
    socket.addEventListener('message', event => {
        const reply = JSON.parse(event.data), request = pending.get(reply.id); if (!request) return;
        pending.delete(reply.id); clearTimeout(request.timer);
        reply.error ? request.reject(Error(reply.error.message)) : request.resolve(reply.result);
    });
    socket.addEventListener('close', () => { for (const req of pending.values()) { clearTimeout(req.timer); req.reject(Error('Debugger closed')); } pending.clear(); });
    const client = { call(method, params = {}) { return new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('Debugger timeout: ' + method)); }, 45000);
        pending.set(id, {resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
    }); } };
    client.evaluate = async expression => {
        const result = await client.call('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    };
    return client;
}
async function click(selector) {
    const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await page.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point}); await pause(120);
}
async function start() {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    const exe = path.join(application, pkg.productName + '.exe');
    child = spawn(exe, ['--user-data-dir=' + userData, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], { env, windowsHide:false, stdio:['ignore','pipe','pipe'] });
    exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    child.stdout.on('data', data => logs.push(String(data))); child.stderr.on('data', data => logs.push(String(data)));
    child.once('error', error => logs.push(error.stack));
    const debug = await until(async () => {
        if (child.exitCode !== null) throw Error('Packaged executable exited: ' + logs.join(''));
        const text = logs.join(''), match = text.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/g);
        return match?.at(-1)?.replace('DevTools listening on ', '');
    });
    browser = await connect(debug);
    const port = new URL(debug).port;
    const target = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page' && x.url.endsWith('/index.html')));
    page = await connect(target.webSocketDebuggerUrl.replace('localhost', '127.0.0.1'));
    await until(() => page.evaluate('document.querySelectorAll(".account-row").length===2 && !document.querySelector("#launch-all-btn").disabled'));
    await page.evaluate('document.title="YT多开浏览器 · 安装包本地回归（临时数据）"');
}
async function close() {
    await browser.call('Browser.close').catch(() => {});
    await Promise.race([exited, pause(15000).then(() => { throw Error('Packaged app did not exit'); })]);
}

(async () => {
    const zip = await require('app-builder-lib/out/toolsets/7zip').getPath7za();
    const extraction = spawnSync(zip, ['x', installer, '-o' + application, '-y'], { windowsHide:true, encoding:'utf8' });
    fs.writeFileSync(path.join(root, 'extraction.log'), extraction.stdout + extraction.stderr);
    assert.equal(extraction.status, 0, extraction.stderr);
    const exe = path.join(application, pkg.productName + '.exe'), archive = path.join(application, 'resources', 'app.asar');
    const packedDir = path.join(path.dirname(installer), 'win-unpacked');
    check('installer EXE and ASAR payload match packaged output', hash(fs.readFileSync(exe)) === hash(fs.readFileSync(path.join(packedDir, pkg.productName + '.exe'))) && hash(fs.readFileSync(archive)) === hash(fs.readFileSync(path.join(packedDir, 'resources/app.asar'))));
    const resources = resedit.NtExecutableResource.from(resedit.NtExecutable.from(fs.readFileSync(exe))).entries;
    const integrity = JSON.parse(Buffer.from(resources.find(x => x.type === 'INTEGRITY' && x.id === 'ELECTRONASAR').bin).toString());
    const entry = integrity.find(x => /resources[\\/]+app\.asar$/.test(x.file));
    check('ASAR integrity resource retained and matches header SHA256', entry?.alg === 'SHA256' && entry.value === hash(asar.getRawHeader(archive).headerString));
    for (const file of ['main.js','preload.js','renderer.js','index.html','style.css','lib/account-manager.js','lib/storage.js','lib/windows-processes.js','lib/security.js']) assert(asar.extractFile(archive, file).equals(fs.readFileSync(path.join(repo, file))), file);
    check('installer contains exact verified production source', true);
    check('no account profiles or tests shipped', !asar.listPackage(archive).some(file => /^[/\\](accounts\.json|profiles|test|scripts)([/\\]|$)/.test(file)));
    fs.mkdirSync(userData);
    const initial = JSON.stringify([{id:'pkg-01',name:'打包测试环境 01',lastUsed:''},{id:'pkg-02',name:'打包测试环境 02',lastUsed:''}]);
    fs.writeFileSync(accountsFile, initial);
    for (const id of ['pkg-01','pkg-02']) { fs.mkdirSync(path.join(profiles,id), {recursive:true}); fs.writeFileSync(path.join(profiles,id,'fixture-marker.txt'), id); }
    await start();
    check('standalone packaged EXE reads only seeded temporary accounts', fs.readFileSync(accountsFile,'utf8') === initial && await page.evaluate('document.querySelectorAll("[data-account^=pkg-]").length===2'));
    check('packaged preload/API and sandbox isolation work', await page.evaluate('typeof require==="undefined" && typeof process==="undefined" && typeof electronAPI.closeProfile==="function" && typeof electronAPI.send==="undefined"'));
    check('packaged version correct', (await page.evaluate('electronAPI.getVersion()')).version === pkg.version);
    await click('[data-open-appearance]'); await click('dialog [data-mode="dark"]'); await click('[data-preset="#8b5cf6"]');
    check('packaged mode and RGB preset work', await page.evaluate('document.documentElement.dataset.theme==="dark" && document.documentElement.style.getPropertyValue("--accent-fill")==="#8b5cf6"'));
    await pause(350);
    fs.writeFileSync(path.join(root,'appearance.png'), Buffer.from((await page.call('Page.captureScreenshot')).data, 'base64'));
    await click('[aria-label="关闭弹窗"]'); await until(() => page.evaluate('!document.querySelector("dialog")'));
    await close(); logs.length = 0;
    await start();
    check('appearance persists across full packaged-process restart', await page.evaluate('document.documentElement.dataset.theme==="dark" && document.documentElement.style.getPropertyValue("--accent-fill")==="#8b5cf6"'));
    check('theme changes and restart preserve original account bytes', fs.readFileSync(accountsFile,'utf8') === initial);
    await click('#launch-all-btn');
    await until(() => page.evaluate('document.querySelectorAll(".account-row.running").length===2 && !document.querySelector("#close-all-btn").disabled'));
    let processes = await listProcesses(profiles);
    check('packaged UI launches two real isolated Chrome environments', processes.length === 2 && new Set(processes.map(x => x.profile)).size === 2);
    const other = processes.find(x => x.profile.endsWith('pkg-02'));
    await click('[data-account="pkg-01"] [data-action="toggle"]');
    await until(() => page.evaluate('document.querySelectorAll(".account-row.running").length===1 && !document.querySelector("#launch-all-btn").disabled'));
    processes = await listProcesses(profiles);
    check('packaged single close preserves other process identity', processes.length === 1 && processes[0].pid === other.pid && processes[0].createdAt === other.createdAt);
    fs.writeFileSync(path.join(root,'dashboard.png'), Buffer.from((await page.call('Page.captureScreenshot')).data, 'base64'));
    await click('#close-all-btn'); await click('[data-confirm]');
    await until(() => page.evaluate('document.querySelectorAll(".account-row.running").length===0 && !document.querySelector("dialog")'));
    check('packaged close-all confirms actual process exit', (await listProcesses(profiles)).length === 0);
    check('profile markers and original IDs retained', ['pkg-01','pkg-02'].every(id => fs.readFileSync(path.join(profiles,id,'fixture-marker.txt'),'utf8') === id) && JSON.parse(fs.readFileSync(accountsFile)).map(x => x.id).join(',') === 'pkg-01,pkg-02');
    await close();
    const result = {passed:true, installer, sha256:hash(fs.readFileSync(installer)), root, checks, installed:false, defaultUserDataUsed:false};
    fs.writeFileSync(path.join(root,'results.json'), JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
})().catch(async error => {
    fs.writeFileSync(path.join(root,'failure.json'), JSON.stringify({root,error:error.stack,checks,logs},null,2));
    console.error(error.stack, root); process.exitCode = 1;
    // Only act on our freshly-created test profiles; never force-kill Chrome.
    if (fs.existsSync(accountsFile)) await new AccountManager({userData}).closeAllProfiles().catch(() => {});
    if (browser) await browser.call('Browser.close').catch(() => {});
}).finally(() => { for (const socket of sockets) socket.close(); });
