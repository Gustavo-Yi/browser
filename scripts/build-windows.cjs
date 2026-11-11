'use strict';
// Packaging-process-only guard. Does not patch node_modules on disk or run in the app.
const fs = require('node:fs');
const path = require('node:path');
const { retryExecutableOpen } = require('./executable-write-retry.cjs');
const root = path.join(__dirname, '..');
process.chdir(root);
require('./build-native.cjs').buildNative();

const pkg = require('../package.json');
const builderVersion = require('app-builder-lib/package.json').version;
if (builderVersion !== pkg.devDependencies['electron-builder']) {
    throw Error('electron-builder version mismatch; run npm ci before packaging.');
}
if (process.platform === 'win32') {
    const windows = require('app-builder-lib/out/electron/electronWin');
    const original = windows.addWinAsarIntegrity;
    if (typeof original !== 'function') throw Error('Unsupported electron-builder integrity writer.');
    windows.addWinAsarIntegrity = (executablePath, integrity) => retryExecutableOpen(
        () => original(executablePath, integrity), executablePath,
        { onRetry: ({ attempt, delay, code, path: file }) => console.warn(
            `[packaging] EXE open temporarily failed (${code}); retry ${attempt} in ${delay} ms: ${file}`
        ) }
    );
}

const args = process.argv.slice(2);
// Local packaging must never publish by default. Release CI already passes --publish always.
if (!args.some(x => x === '--publish' || x.startsWith('--publish=') || x === '-p')) args.push('--publish', 'never');
// Reuse the exact installed runtime rather than re-downloading the same 100+ MB archive.
// Only auto-select it for a native Windows build; explicit cross-architecture flags keep builder defaults.
const hasRuntimeOverride = args.some(x => /electronDist|electronVersion|^--(x64|armv7l|arm64|ia32|universal|arch|linux|mac)(=|$)|^-[lm]$/.test(x));
if (process.platform === 'win32' && !hasRuntimeOverride) {
    const dist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
    const installed = fs.readFileSync(path.join(dist, 'version'), 'utf8').trim().replace(/^v/, '');
    if (installed !== pkg.devDependencies.electron) throw Error('Installed Electron runtime version mismatch; run npm ci.');
    args.push('--config.electronDist=' + dist);
}
const cli = require.resolve('electron-builder/out/cli/cli.js');
process.argv = [process.execPath, cli, ...args];
require(cli);
