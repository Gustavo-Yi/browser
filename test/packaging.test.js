'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { retryExecutableOpen, isRetryableOpen } = require('../scripts/executable-write-retry.cjs');
const target = path.join(os.tmpdir(), 'yt-test.exe');
const openError = (code = 'UNKNOWN', overrides = {}) => Object.assign(Error('fixture locked'), { code, syscall: 'open', path: target, ...overrides });

test('EXE open guard retries only matching unopened target and recovers', async () => {
    let calls = 0; const waits = [];
    const result = await retryExecutableOpen(async () => { if (++calls < 3) throw openError(); return 'complete'; }, target,
        { delays: [10, 20], wait: async delay => waits.push(delay) });
    assert.equal(result, 'complete'); assert.equal(calls, 3); assert.deepEqual(waits, [10, 20]);
});
test('permanent EXE locks stop at the retry limit with the original error', async () => {
    let calls = 0; const error = openError('EBUSY');
    await assert.rejects(retryExecutableOpen(async () => { calls++; throw error; }, target, { delays: [0,0], wait: async () => {} }), e => e === error);
    assert.equal(calls, 3);
});
test('partial writes, other paths, missing files and invalid PE errors are never retried', async () => {
    for (const e of [openError('UNKNOWN', {syscall:'write'}), openError('UNKNOWN', {path:target+'.other'}), openError('ENOENT'), Error('Invalid PE'), openError('ENOSPC')]) {
        let calls = 0;
        await assert.rejects(retryExecutableOpen(async () => { calls++; throw e; }, target, { wait: async () => assert.fail('must not wait') }), x => x === e);
        assert.equal(calls, 1);
    }
    assert.equal(isRetryableOpen(openError('UNKNOWN', {path:target+'.txt'}), target+'.txt'), false);
});
test('Windows sharing lock reproduces UNKNOWN/open and safe retry succeeds after release', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-exe-retry-test-'));
    const file = path.join(dir, 'fixture.exe');
    const before = Buffer.from('disposable, non-executable packaging fixture'); fs.writeFileSync(file, before);
    const ps = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',
        '$ErrorActionPreference="Stop";$f=[IO.File]::Open($env:YT_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);try{[Console]::Out.WriteLine("LOCK_READY");[Console]::Out.Flush();Start-Sleep -Milliseconds 1600}finally{$f.Dispose()}'],
        { env: {...process.env, YT_LOCK_FILE:file}, windowsHide:true, stdio:['ignore','pipe','pipe'] });
    const exited = new Promise(resolve => ps.once('exit', resolve));
    try {
        await new Promise((resolve, reject) => {
            ps.once('error', reject); ps.once('exit', () => reject(Error('Lock helper exited before readiness')));
            ps.stdout.on('data', chunk => { if (String(chunk).includes('LOCK_READY')) resolve(); });
        });
        await assert.rejects(fs.promises.writeFile(file, 'new data'), e => isRetryableOpen(e, file));
        assert.deepEqual(fs.readFileSync(file), before, 'Failed open must leave original bytes intact');
        let retries = 0;
        await retryExecutableOpen(() => fs.promises.writeFile(file, 'new data'), file, { onRetry: () => retries++ });
        assert(retries > 0); assert.equal(fs.readFileSync(file, 'utf8'), 'new data');
    } finally { await exited; }
});
