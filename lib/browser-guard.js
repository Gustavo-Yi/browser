'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const readline = require('node:readline');

function guardExecutable() {
    // extraResources lives outside ASAR; development uses the same compiled helper.
    const packaged = process.resourcesPath && path.join(process.resourcesPath, 'native', 'YTBrowserGuard.exe');
    return packaged && fs.existsSync(packaged) ? packaged : path.join(__dirname, '..', 'native', 'bin', 'YTBrowserGuard.exe');
}

class BrowserGuard {
    constructor() { this.children = new Map(); this.pending = new Set(); }
    start(request) {
        const child = new EventEmitter(); child.pid = null;
        child.unref = () => {};
        child.finished = new Promise(resolve => { child.finish = resolve; });
        this.pending.add(child);
        const helper = spawn(guardExecutable(), [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child.helper = helper;
        child.abort = () => helper.stdin.end();
        let failure = false, ready = false, diagnostic = '';
        const fail = error => { if (!failure) { failure = true; child.emit('error', error); } };
        helper.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-3000); });
        helper.stdin.on('error', error => { if (!ready) fail(error); });
        helper.on('error', fail);
        const lines = readline.createInterface({ input: helper.stdout });
        lines.on('line', line => {
            try {
                const message = JSON.parse(line.replace(/^\uFEFF/, ''));
                if (message.type === 'spawn') {
                    ready = true; child.pid = message.pid;
                    this.children.set(child.pid, child); child.emit('spawn');
                } else if (message.type === 'error') fail(Error(message.message));
            } catch (error) { fail(error); }
        });
        helper.once('close', code => {
            lines.close(); this.pending.delete(child);
            if (this.children.get(child.pid) === child) this.children.delete(child.pid);
            if (!ready && !failure) fail(Error('浏览器进程保护启动失败。' + diagnostic));
            child.emit('exit', code); child.finish();
        });
        helper.stdin.write(JSON.stringify(request) + '\n');
        return child;
    }
    spawn(exe, args) { return this.start({ mode: 'launch', exe, args }); }
    async adopt(record) {
        const existing = this.children.get(record.pid);
        if (existing && (!existing.identity || existing.identity === record.createdAt)) {
            existing.identity = record.createdAt;
            return;
        }
        const child = this.start({ mode: 'adopt', ...record });
        child.identity = record.createdAt;
        await new Promise((resolve, reject) => {
            child.once('spawn', resolve); child.once('error', reject);
        });
    }
    async forceAll() {
        const children = [...this.pending];
        for (const child of children) child.helper.stdin.write('force\n');
        await this.waitFor(children);
    }
    async waitFor(children = [...this.pending], timeout = 15000) {
        let timer;
        try {
            await Promise.race([Promise.all(children.map(child => child.finished)), new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error('仍有浏览器子进程未退出，客户端将继续运行。')), timeout);
            })]);
        } finally { clearTimeout(timer); }
    }
}
module.exports = { BrowserGuard, guardExecutable };
