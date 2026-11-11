'use strict';
// Disposable owner process for abrupt-exit tests. NEVER opens production profiles.
const path = require('node:path');
const { AccountManager } = require('../lib/account-manager');
const { BrowserGuard } = require('../lib/browser-guard');
const root = process.argv[2];
if (!path.basename(root).startsWith('yt-guard-regression-')) throw Error('Expected isolated test directory');
const guard = new BrowserGuard();
const spawn = guard.spawn.bind(guard);
guard.spawn = (exe, args) => spawn(exe, [...args.filter(x => x !== '--start-maximized'),
    '--window-position=-32000,-32000', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank']);
const manager = new AccountManager({ userData: root, guard });
(async () => {
    for (const account of manager.accounts) {
        const result = await manager.launchProfile(account.id);
        if (!result.ok) throw Error(result.message);
    }
    process.send({ ready: true, pids: [...manager.activeProcesses.values()].flat().map(x => x.pid) });
    process.on('message', async command => {
        try {
            manager.beginShutdown();
            if (command === 'force') await manager.forceCloseAllProfiles();
            else { const result = await manager.closeAllProfiles(); if (result.failed) throw Error(JSON.stringify(result)); }
            await manager.waitForBrowserExit(); process.send({ closed: true }); process.exit(0);
        } catch (error) { process.send({ error: error.stack }); process.exit(1); }
    });
})().catch(error => { process.send({ error: error.stack }); process.exit(1); });
