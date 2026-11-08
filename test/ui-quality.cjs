'use strict';
// Same production renderer + main/preload, fresh fixture data only; never launches Chrome.
const electron = require('electron');
const {app, BrowserWindow, nativeTheme} = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Module = require('node:module'), assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {AccountManager} = require('../lib/account-manager');
const repo = path.join(__dirname,'..'), phase = process.argv[2] || 'after';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-ui-quality-' + phase + '-'));
const userData = path.join(root,'userData'), appData = path.join(root,'appData');
fs.mkdirSync(userData); fs.mkdirSync(appData);
app.setPath('userData', userData); app.setPath('sessionData', userData); app.setPath('appData',appData);
app.getVersion = () => require('../package.json').version;
// Measure both phases with the SAME rendering mode, including a software fallback run.
if (process.argv.includes('--software')) app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-background-networking');
nativeTheme.themeSource = 'light';
const initial = JSON.stringify(Array.from({length:6},(_,i)=>({id:`quality-${i+1}`,name:['WhatsApp 业务01','WhatsApp 业务02','客户跟进03','客户跟进04','备用账号05','测试环境06'][i],lastUsed:''})));
const accountsFile = path.join(userData,'accounts.json'); fs.writeFileSync(accountsFile, initial);
let win, manager;
const errors=[], updater = new EventEmitter(); updater.downloadUpdate=async()=>{};
const load=Module._load;
Module._load=function(request,parent,...args){
  if(parent?.filename===path.join(repo,'main.js')){
    if(request==='electron')return {...electron,BrowserWindow:function(options){
      win=new BrowserWindow({...options,show:false,width:1280,height:800,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});
      win.setContentSize(1280,800); win.show=()=>{};win.focus=()=>{};win.setAlwaysOnTop=()=>{};
      win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message)});return win;
    }};
    if(request==='electron-updater')return {autoUpdater:updater};
    if(request==='./lib/account-manager')return {AccountManager:class extends AccountManager{constructor(options){super({...options,processes:{listProcesses:async()=>[]},spawnProcess:()=>{throw Error('No Chrome in quality tests')}});manager=this;}}};
  }
  return load.call(this,request,parent,...args);
};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=code=>win.webContents.executeJavaScript(code).catch(e=>{throw Error(e.message+'\n'+code)});
async function until(fn){const end=Date.now()+20000;while(Date.now()<end){if(await fn())return;await pause(30)}throw Error('UI quality timeout')}
async function shot(name){await pause(250);await win.webContents.capturePage();await pause(80);fs.writeFileSync(path.join(root,name+'.png'),(await win.webContents.capturePage()).toPNG())}
async function metrics(){const {metrics}=await win.webContents.debugger.sendCommand('Performance.getMetrics');return Object.fromEntries(metrics.map(m=>[m.name,m.value]))}
function delta(a,b){return Object.fromEntries(['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].map(k=>[k, +(b[k]-a[k]).toFixed(5)]))}
const timeout=setTimeout(()=>{console.error('Watchdog',root);app.exit(2)},120000);
require('../main.js');
app.whenReady().then(async()=>{
  await until(async()=>win&&!win.webContents.isLoading()&&await evaluate('document.querySelectorAll(".account-row").length===6').catch(()=>false));
  win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});await win.webContents.debugger.sendCommand('Performance.enable');
  const geometry=await evaluate(`({dpr:devicePixelRatio,innerWidth,innerHeight,title:getComputedStyle(document.querySelector('h1')).fontSize,row:document.querySelector('.account-row').getBoundingClientRect().height,sidebar:document.querySelector('.sidebar').getBoundingClientRect().width,blur:getComputedStyle(document.querySelector('.glass')).backdropFilter,bodyHeight:document.documentElement.scrollHeight})`);
  geometry.zoom=win.webContents.getZoomFactor(); await shot('dashboard-1280');
  await evaluate(`document.querySelector('[data-open-appearance]').click()`);await pause(400);
  const sizes=[];
  for(const [width,height]of [[1280,800],[1024,700],[920,640]]){
    win.setContentSize(width,height);await pause(200);
    sizes.push(await evaluate(`(()=>{const d=document.querySelector('dialog'),r=d.getBoundingClientRect();return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dialogHeight:r.height,dialogScroll:d.scrollHeight,dialogClient:d.clientHeight,inside:r.top>=0&&r.bottom<=innerHeight}})()`));
    await shot('appearance-'+width);
  }
  win.setContentSize(1280,800);await pause(200);
  // Watch only the appearance storage key, never account data.
  await evaluate(`window.__writes=0;window.__realSet=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='yt-browser.appearance.v1')window.__writes++;return window.__realSet.call(this,k,v)};true`);
  const before=await metrics();
  const responsiveness=await evaluate(`(async()=>{
    const frame=()=>new Promise(requestAnimationFrame), times=[];
    const states=[['light','#1263ee'],['dark','#8b5cf6'],['light','#707070'],['dark','#ea7724']];
    for(const [mode,color]of states){await frame();const t=performance.now();document.querySelector('dialog [data-mode="'+mode+'"]').click();document.querySelector('[data-preset="'+color+'"]').click();const rgb=color.slice(1).match(/../g).map(x=>parseInt(x,16)).join(', ');let frames=0;do{await frame();frames++}while(getComputedStyle(document.querySelector('.accent-example')).backgroundColor!=='rgb('+rgb+')'&&frames<90);times.push(performance.now()-t)}
    return {settleMs:times,writes:window.__writes};
  })()`);
  const themeWork=delta(before,await metrics());
  // Stress fixture: real renderer with 200 inert records, no user directories.
  manager.accountsStore.value=Array.from({length:200},(_,i)=>({id:`stress-${i}`,name:`性能测试 ${i+1}`,lastUsed:''}));manager.publish();await pause(200);
  await evaluate('window.__writes=0');const dragBefore=await metrics();
  const drag=await evaluate(`(async()=>{const samples=[],frame=()=>new Promise(requestAnimationFrame),input=document.querySelector('#rgb-0-slider'),set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;let prev=performance.now();for(let i=0;i<60;i++){await frame();const now=performance.now();samples.push(now-prev);prev=now;set.call(input,String(30+i*3));input.dispatchEvent(new Event('input',{bubbles:true}))}await frame();return {frames:samples,writesDuring:window.__writes}})()`);
  const dragWork=delta(dragBefore,await metrics());await pause(300);drag.writesAfter=await evaluate('window.__writes');
  const liveRgb=await evaluate(`JSON.parse(localStorage.getItem('yt-browser.appearance.v1')).rgb`);assert.equal(liveRgb[0],207);
  assert.equal(fs.readFileSync(accountsFile,'utf8'),initial);assert.deepEqual(errors,[]);
  if(phase!=='before'){
    assert.equal(geometry.zoom,1);assert(parseInt(geometry.title)<=32);assert(geometry.row<=68);assert.equal(geometry.blur,'none');
    assert(sizes.every(x=>x.scrollWidth<=x.width&&x.inside));assert(sizes.every(x=>x.dialogScroll<=x.dialogClient+2),'appearance should fit all tested desktop heights');
    assert(drag.writesDuring<=3);assert(drag.writesAfter<=3);
    assert(await evaluate(`!document.body.innerText.includes('已固定为')&&!document.body.innerText.includes('当前为浅色模式')&&!document.body.innerText.includes('当前为深色模式')`));
    assert(await evaluate(`!getComputedStyle(document.querySelector('.accent-example')).transitionProperty.includes('background')`),'theme colors must not animate through intermediate shades');
    // Close before the 160 ms debounce: the very last slider value must be flushed.
    const immediate = await evaluate(`(async()=>{const el=document.querySelector('#rgb-0-slider');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'209');el.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(requestAnimationFrame);document.querySelector('.appearance-actions .button.primary').click();return JSON.parse(localStorage.getItem('yt-browser.appearance.v1')).rgb[0]})()`);
    assert.equal(immediate,209,'closing settings must flush pending preferences');
    await until(async()=>await evaluate('!document.querySelector("dialog")'));
    await evaluate(`document.querySelector('.mode-choices.compact [data-mode="light"]').click()`);
    await pause(30);
    win.webContents.reload();
    await until(async()=>await evaluate(`!!document.querySelector('[data-open-appearance]')&&document.documentElement.dataset.theme==='light'`).catch(()=>false));
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('yt-browser.appearance.v1')).mode`),'light','rapid reload must flush sidebar mode selection');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('yt-browser.appearance.v1')).rgb[0]`),209);
    assert.equal(fs.readFileSync(accountsFile,'utf8'),initial);
    assert.deepEqual(errors,[]);
  }
  const result={phase,root,software:process.argv.includes('--software'),gpu:app.getGPUFeatureStatus(),geometry,sizes,responsiveness,themeWork,drag,dragWork,errors,passed:true};
  fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({phase,root,geometry,responsiveness,themeWork,dragWork,writes:drag.writesAfter}));clearTimeout(timeout);app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(root,'error.txt'),error.stack);console.error(error.stack,root);app.exit(1)});
