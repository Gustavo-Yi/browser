'use strict';
const path = require('node:path');

const RETRY_DELAYS_MS = Object.freeze([200, 400, 800, 1600, 3200, 5000]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isRetryableOpen(error, executablePath) {
    // Never retry partial writes, malformed PE resources, or unrelated file errors.
    // A failed open has not truncated or written the executable.
    return ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code) &&
        error.syscall === 'open' && typeof error.path === 'string' &&
        path.resolve(error.path).toLowerCase() === path.resolve(executablePath).toLowerCase() &&
        path.extname(executablePath).toLowerCase() === '.exe';
}

async function retryExecutableOpen(action, executablePath, {
    delays = RETRY_DELAYS_MS, wait = sleep, onRetry = () => {}
} = {}) {
    for (let attempt = 0; ; attempt++) {
        try { return await action(); }
        catch (error) {
            if (!isRetryableOpen(error, executablePath) || attempt >= delays.length) throw error;
            onRetry({ attempt: attempt + 1, delay: delays[attempt], code: error.code, path: executablePath });
            await wait(delays[attempt]);
        }
    }
}

module.exports = { RETRY_DELAYS_MS, isRetryableOpen, retryExecutableOpen };
