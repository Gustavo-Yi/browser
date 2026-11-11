'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ClientLifecycle } = require('../lib/client-lifecycle');

function setup(count = 0, options = {}) {
    const state = { running: count, quits: 0, hidden: false, errors: [], closeCalls: 0, forces: 0, blocked: false };
    const manager = {
        beginShutdown() { state.blocked = true; }, cancelShutdown() { state.blocked = false; },
        async closeAllProfiles() {
            state.closeCalls++;
            if (options.wait) await options.wait;
            if (options.unknown) throw Error('unknown inventory');
            if (options.fail) return { failed: state.running };
            state.running = 0; return { failed: 0 };
        },
        async waitForBrowserExit() { if (options.childrenLive) throw Error('children still alive'); },
        async forceCloseAllProfiles() {
            state.forces++; if (options.forceFails) throw Error('force failed');
            state.running = 0; options.childrenLive = false;
        }
    };
    const lifecycle = new ClientLifecycle({ manager,
        chooseClose: async () => options.choice ?? 0,
        chooseFailure: async () => options.failureChoice ?? 2,
        reportError: async error => state.errors.push(error.message),
        hide: () => { state.hidden = true; }, quit: () => { assert.equal(state.running, 0); state.quits++; }
    });
    return { state, lifecycle, options };
}

for (const count of [0, 1, 4, 7, 25]) {
    test(`exit closes ALL ${count} environments before quitting (no fixed count)`, async () => {
        const { state, lifecycle } = setup(count, { choice: 1 });
        await lifecycle.closeWindow();
        assert.equal(state.running, 0); assert.equal(state.quits, 1); assert.equal(lifecycle.allowQuit, true);
    });
    test(`tray minimization preserves all ${count} environments and the live client`, async () => {
        const { state, lifecycle } = setup(count);
        await lifecycle.closeWindow();
        assert.equal(state.hidden, true); assert.equal(state.running, count);
        assert.equal(state.closeCalls, 0); assert.equal(state.quits, 0); assert.equal(state.blocked, false);
    });
}
test('cancel and Escape do not close browsers or hide the window', async () => {
    const { state, lifecycle } = setup(7, { choice: 2 });
    await lifecycle.closeWindow(); assert.equal(state.running, 7); assert.equal(state.hidden, false); assert.equal(state.quits, 0);
});
test('failed graceful close keeps client alive; cancel unblocks operations', async () => {
    const { state, lifecycle } = setup(7, { fail: true });
    assert.equal(await lifecycle.exit(), false); assert.equal(state.running, 7);
    assert.equal(state.quits, 0); assert.equal(state.blocked, false); assert.equal(state.forces, 0);
});
test('force needs explicit selection; failure must never quit client', async () => {
    const { state, lifecycle, options } = setup(7, { fail: true, failureChoice: 1, forceFails: true });
    assert.equal(await lifecycle.exit(), false); assert.equal(state.quits, 0); assert.equal(state.errors.length, 1);
    options.forceFails = false;
    assert.equal(await lifecycle.exit(), true); assert.equal(state.running, 0); assert.equal(state.quits, 1);
});
test('double close / tray quit requests share one cleanup and synchronous launch gate', async () => {
    let resume;
    const { state, lifecycle } = setup(7, { wait: new Promise(resolve => { resume = resolve; }) });
    const first = lifecycle.exit(); assert.equal(state.blocked, true);
    const second = lifecycle.exit(); assert.equal(first, second);
    resume(); await first; assert.equal(state.closeCalls, 1); assert.equal(state.quits, 1);
});
test('update and session end fail closed when inventory is unavailable', async () => {
    const { state, lifecycle } = setup(7, { unknown: true });
    await assert.rejects(lifecycle.exit({ interactive: false }), /unknown inventory/);
    assert.equal(state.quits, 0); assert.equal(state.forces, 0); assert.equal(state.blocked, false);
});
test('remaining background child processes also prevent client exit', async () => {
    const { state, lifecycle } = setup(0, { childrenLive: true });
    assert.equal(await lifecycle.exit(), false); assert.equal(state.quits, 0);
});
