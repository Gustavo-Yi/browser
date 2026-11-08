'use strict';
// This test EXECUTES INSTALLERS. It is forbidden on developer/user computers.
// Only a new GitHub-hosted Windows runner may execute it, never self-hosted CI.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.GITHUB_REPOSITORY !== 'Gustavo-Yi/browser' ||
    process.env.YT_ALLOW_DISPOSABLE_INSTALL !== 'github-hosted-runner-only') {
    throw Error('Real installation test is restricted to disposable GitHub-hosted Windows runners.');
}

const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const asar = require('@electron/asar'), yaml = require('js-yaml');
const {findChromePath} = require('../lib/account-manager');
const {listProcesses} = require('../lib/windows-processes');
const repo = 'Gustavo-Yi/browser', target = (process.env.YT_TARGET_VERSION || '').replace(/^v/,'');
assert.match(target, /^\d+\.\d+\.\d+$/);
assert.equal(target, require('../package.json').version);
const oldVersion = '2.2.12';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-installed-upgrade-'));
const evidence = path.resolve('update-verification'); fs.mkdirSync(evidence, {recursive:true});
const installDir = path.join(root, 'installed-client');
const exe = path.join(installDir, 'YT多开浏览器.exe');
const checks = [], sockets = [], logs = [];
let child, browser, page, userData, server;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = (data, alg = 'sha256', encoding = 'hex') => crypto.createHash(alg).update(data).digest(encoding);
function check(label, condition) { assert(condition, label); checks.push(label); console.log('PASS ' + label); }
async function until(fn, timeout = 60000) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) {
        try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
        await pause(200);
    }
    throw Error('Timed out: ' + (last?.stack || fn.toString()));
}
async function download(asset, file, tag) {
    // Bootstrap via the official asset API; direct browser-download requests can
    // be blocked by the runner's gateway. The installed updater itself is NEVER
    // redirected, mocked, or patched and must download through its normal feed.
    const result = spawnSync('gh',['release','download',tag,'--repo',repo,'--pattern',asset.name,'--output',file],
        {windowsHide:true,encoding:'utf8',timeout:180000});
    assert.equal(result.status,0,result.stderr || result.error?.message);
    return fs.readFileSync(file);
}
async function release(tag) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
        headers:{Accept:'application/vnd.github+json', Authorization:'Bearer ' + process.env.GH_TOKEN},
        signal:AbortSignal.timeout(30000)
    });
    assert.equal(response.status, 200); return response.json();
}
async function cdp(url) {
    assert(url.startsWith('ws://127.0.0.1:'), 'Debugger must be loopback only');
    const socket = new WebSocket(url); sockets.push(socket);
    await new Promise((resolve, reject) => {socket.addEventListener('open', resolve, {once:true});socket.addEventListener('error', reject, {once:true});});
    let seq = 0; const pending = new Map();
    socket.addEventListener('message', event => {
        const reply = JSON.parse(event.data), req = pending.get(reply.id); if (!req) return;
        pending.delete(reply.id); clearTimeout(req.timer);
        reply.error ? req.reject(Error(JSON.stringify(reply.error))) : req.resolve(reply.result);
    });
    socket.addEventListener('close', () => {for (const r of pending.values()) {clearTimeout(r.timer);r.reject(Error('Debugger closed'));}pending.clear();});
    return {socket, call(method, params = {}) {return new Promise((resolve, reject) => {
        const id = ++seq, timer = setTimeout(() => {pending.delete(id);reject(Error('Debugger timeout: ' + method));}, 30000);
        pending.set(id, {resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    });}, async evaluate(expression) {
        const result = await this.call('Runtime.evaluate', {expression,awaitPromise:true,returnByValue:true});
        if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
    }};
}
function cleanEnv() {
    const env = {...process.env};
    for (const key of ['ELECTRON_RUN_AS_NODE','GH_TOKEN','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN']) delete env[key];
    return env;
}
async function start(version) {
    const localLogs = [];
    child = spawn(exe, ['--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--inspect=127.0.0.1:0','--disable-gpu'], {env:cleanEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data', d => {localLogs.push(String(d));logs.push(String(d));});
    child.stderr.on('data', d => {localLogs.push(String(d));logs.push(String(d));});
    child.on('error', e => logs.push(e.stack));
    const debug = await until(() => localLogs.join('').match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)?.[1]);
    const inspect = await until(() => localLogs.join('').match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/\S+)/)?.[1]);
    const main = await cdp(inspect);
    const paths = await main.evaluate(`({userData:process.mainModule.require('electron').app.getPath('userData'),version:process.mainModule.require('electron').app.getVersion()})`);
    main.socket.close(); // Do not hold Node's inspector open during real quitAndInstall.
    assert.equal(paths.version, version);
    const relative = path.relative(process.env.APPDATA, paths.userData);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    if (userData) assert.equal(paths.userData, userData, 'Upgrade must retain the same default userData');
    userData = paths.userData;
    browser = await cdp(debug);
    const port = new URL(debug).port;
    const tab = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page' && x.url.endsWith('/index.html')));
    page = await cdp(tab.webSocketDebuggerUrl.replace('localhost','127.0.0.1'));
    await until(() => page.evaluate('!!document.querySelector("#nav-update-btn")'));
    return paths;
}
async function stop() {
    await browser.call('Browser.close').catch(() => {});
    await until(() => child.exitCode !== null);
}
async function click(selector) {
    const point = await page.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing control');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
    await page.call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...point});
    await page.call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...point}); await pause(100);
}
async function screenshot(name) {fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from((await page.call('Page.captureScreenshot')).data,'base64'));}
function versionOnDisk() {
    // NSIS replaces this path in-place; do not reuse the old archive's cached header.
    const archive = path.join(installDir,'resources/app.asar');
    try {asar.uncache(archive);return JSON.parse(asar.extractFile(archive,'package.json')).version;}catch{return null;}
}
const ids = ['upgrade-10001','upgrade-20002'];
function loginSnapshot() {
    const result = {};
    function walk(file) {
        if (!fs.existsSync(file)) return;
        if (fs.statSync(file).isDirectory()) {for(const name of fs.readdirSync(file)) walk(path.join(file,name));}
        else result[path.relative(userData,file)] = hash(fs.readFileSync(file));
    }
    for (const id of ids) for (const tail of ['Local State','Default/Preferences','Default/Network/Cookies','Default/Local Storage','Default/IndexedDB']) walk(path.join(userData,'profiles',id,tail));
    assert(Object.keys(result).length > 10, 'Real Chrome login fixtures must be present'); return result;
}
async function chromeStorage(write) {
    const chrome = findChromePath({}); assert(chrome, 'Chrome must be installed on hosted runner');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const chromeBrowsers = [];
    try {
        for (const id of ids) {
            const profile = path.join(userData,'profiles',id);
            spawn(chrome, [`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--disable-background-networking','--disable-component-update','--disable-sync','--disable-gpu','--window-position=-32000,-32000',origin], {windowsHide:true,env:cleanEnv(),stdio:'ignore'}).unref();
            const endpoint = await until(async () => {
                const [port,suffix] = fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split(/\r?\n/);
                const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
                const tab = tabs.find(x => x.type==='page' && x.url.startsWith(origin));
                return tab && {tab:tab.webSocketDebuggerUrl,browser:`ws://127.0.0.1:${port}${suffix}`};
            });
            const control = await cdp(endpoint.browser), tab = await cdp(endpoint.tab); chromeBrowsers.push(control);
            if (write) {
                await tab.evaluate(`document.cookie='fixtureLogin=${id}; Max-Age=86400; Path=/; SameSite=Lax';localStorage.setItem('fixtureLogin','${id}');new Promise((resolve,reject)=>{const r=indexedDB.open('login-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('state');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,tx=db.transaction('state','readwrite');tx.objectStore('state').put('${id}','session');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})`);
            } else {
                assert(await tab.evaluate(`document.cookie.includes('fixtureLogin=${id}')&&localStorage.getItem('fixtureLogin')==='${id}'`), 'Cookie/localStorage: ' + id);
                assert.equal(await tab.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('login-fixture',1);r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('state').objectStore('state').get('session');q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)}})`),id);
            }
        }
    } finally {
        for (const c of chromeBrowsers) await c.call('Browser.close').catch(() => {});
        await until(async () => (await listProcesses(path.join(userData,'profiles'))).length === 0);
    }
}
const watchdog = setTimeout(() => {fs.writeFileSync(path.join(evidence,'watchdog.log'),logs.join(''));process.exit(2);},15*60*1000);
(async () => {
    const published = await release('v'+target), previous = await release('v'+oldVersion);
    check('target is a published stable release', !published.draft && !published.prerelease);
    const latestAsset = published.assets.find(x => x.name === 'latest.yml'); assert(latestAsset);
    const manifest = yaml.load((await download(latestAsset,path.join(evidence,'latest.yml'),'v'+target)).toString());
    assert.equal(manifest.version,target);
    const entry = manifest.files.find(x => x.url.endsWith('.exe')); assert(entry);
    const installerAsset = published.assets.find(x => x.name === decodeURIComponent(entry.url)); assert(installerAsset, entry.url);
    const installerBytes = await download(installerAsset,path.join(root,'new-setup.exe'),'v'+target);
    check('public update manifest size and SHA512 match downloadable installer', installerBytes.length===entry.size && hash(installerBytes,'sha512','base64')===entry.sha512);
    const oldAsset = previous.assets.find(x => x.name.endsWith('.exe')); assert(oldAsset);
    const oldSetup = path.join(root,'old-setup.exe'); await download(oldAsset,oldSetup,'v'+oldVersion);
    // Both registry/shortcut changes and the default app data belong only to this disposable runner.
    const installed = spawnSync(oldSetup, ['/S','/CURRENTUSER',`/D=${installDir}`], {env:cleanEnv(),windowsHide:true,timeout:120000});
    assert.equal(installed.status,0);assert.equal(versionOnDisk(),oldVersion);
    await start(oldVersion); await stop();
    check('actual 2.2.12 NSIS installation starts', true);
    const accountsFile = path.join(userData,'accounts.json');
    fs.writeFileSync(accountsFile,JSON.stringify(ids.map((id,i)=>({id,name:`升级保留测试 ${i+1}`,lastUsed:''})),null,2));
    server = http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated upgrade fixture</title>Local test only');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    await chromeStorage(true);
    await start(oldVersion);
    await until(() => page.evaluate(`document.body.innerText.includes('升级保留测试 1')&&document.body.innerText.includes('升级保留测试 2')`));
    const beforeAccounts = fs.readFileSync(accountsFile), beforeLogin = loginSnapshot();
    const config = yaml.load(fs.readFileSync(path.join(installDir,'resources/app-update.yml'),'utf8'));
    assert.equal(config.owner,'Gustavo-Yi');assert.equal(config.repo,'browser');
    await click('#nav-update-btn');
    const downloadState = await until(() => page.evaluate(`(()=>{const d=document.querySelector('#update-dock');return d&&(d.classList.contains('ready')||d.classList.contains('error'))&&{ready:d.classList.contains('ready'),text:d.innerText}})()`),300000);
    assert(downloadState.ready,downloadState.text);
    await screenshot('old-client-update-ready');
    const pendingDir = path.join(process.env.LOCALAPPDATA,config.updaterCacheDirName,'pending');
    const downloaded = fs.readdirSync(pendingDir).find(x=>x.endsWith('.exe'));assert(downloaded);
    check('installed old client detects and downloads exact published 2.2.13', hash(fs.readFileSync(path.join(pendingDir,downloaded)),'sha512','base64')===entry.sha512);
    await click('#update-dock-action').catch(error => {if(error.message !== 'Debugger closed')throw error;});
    await until(() => child.exitCode !== null);
    await until(() => versionOnDisk()===target,180000);
    // The real updater invokes the real NSIS installer and restarts the new installed EXE.
    const env = {...process.env,YT_VERIFIED_EXE:exe};
    const ps = code => spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{env,windowsHide:true,encoding:'utf8',timeout:15000});
    await until(() => {
        const r=ps(`$p=Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:YT_VERIFIED_EXE -and $_.MainWindowHandle -ne 0 }; if($p){'READY'}`);
        return r.stdout.includes('READY');
    },60000);
    check('real updater runs NSIS and automatically restarts installed 2.2.13',true);
    check('installation retains account bytes and Chrome login stores',fs.readFileSync(accountsFile).equals(beforeAccounts));
    assert.deepEqual(loginSnapshot(),beforeLogin);
    // Close only the restarted test EXE gracefully, then reconnect with test-only debugging flags.
    ps(`Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:YT_VERIFIED_EXE -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`);
    await until(()=>!ps(`@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $env:YT_VERIFIED_EXE }).Count`).stdout.trim().match(/^[1-9]/));
    await start(target);
    const archive = path.join(installDir,'resources/app.asar');
    // Windows Git checkout can use CRLF while a local release build uses LF.
    const normalized = value => value.toString('utf8').replace(/\r\n/g,'\n');
    for (const file of ['main.js','preload.js','renderer.js','style.css','lib/account-manager.js','lib/storage.js']) assert.equal(normalized(asar.extractFile(archive,file)),normalized(fs.readFileSync(path.join(__dirname,'..',file))),file);
    const state = await page.evaluate('electronAPI.getState()');assert.deepEqual(state.accounts.map(x=>x.id),ids);
    check('new installed production code uses the original default data directory and IDs',true);
    await click('[data-open-appearance]');await click('dialog [data-mode="dark"]');await click('[data-preset="#8b5cf6"]');
    await screenshot('upgraded-appearance');await click('[aria-label="关闭弹窗"]');await pause(250);
    await click('#launch-all-btn');
    await until(()=>page.evaluate('document.querySelectorAll(".account-row.running").length===2&&!document.querySelector("#launch-all-btn").disabled'));
    check('upgraded client launches two distinct real Chrome profiles',(await listProcesses(path.join(userData,'profiles'))).length===2);
    await click('[data-account="upgrade-10001"] [data-action="toggle"]');
    await until(()=>page.evaluate('document.querySelectorAll(".account-row.running").length===1&&!document.querySelector("#close-all-btn").disabled'));
    check('single close leaves the other environment running',(await listProcesses(path.join(userData,'profiles'))).length===1);
    await click('#close-all-btn');await click('[data-confirm]');
    await until(()=>page.evaluate('document.querySelectorAll(".account-row.running").length===0&&!document.querySelector("dialog")'));
    await chromeStorage(false);check('Cookie, localStorage and IndexedDB survive actual upgrade and reopen',true);
    await click('#nav-update-btn');await click('dialog .button.primary');
    await until(()=>page.evaluate('document.querySelector("dialog")?.textContent.includes("当前已是最新版本")'),60000);
    check('new client update check correctly reports latest version',true);
    await screenshot('upgraded-latest');await stop();
    await start(target);
    check('appearance persists across installed-client restart',await page.evaluate('document.documentElement.dataset.theme==="dark"&&document.documentElement.style.getPropertyValue("--accent-fill")==="#8b5cf6"'));
    await stop();
    fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify({passed:true,from:oldVersion,to:target,release:published.html_url,installerSha256:hash(installerBytes),checks,runner:process.env.RUNNER_ENVIRONMENT,realInstall:true,productionUserDataAccessed:false},null,2));
    console.log('PUBLISHED UPDATE VERIFIED');
})().catch(async error => {
    console.error(error.stack);process.exitCode=1;
    fs.writeFileSync(path.join(evidence,'failure.json'),JSON.stringify({error:error.stack,checks,root,userData},null,2));
    try {await screenshot('failure');}catch{}
}).finally(()=>{
    clearTimeout(watchdog);fs.writeFileSync(path.join(evidence,'process.log'),logs.join(''));
    if(userData && fs.existsSync(path.join(userData,'logs','main.log')))fs.copyFileSync(path.join(userData,'logs','main.log'),path.join(evidence,'updater.log'));
    for(const socket of sockets)socket.close();if(server)server.close();
});
