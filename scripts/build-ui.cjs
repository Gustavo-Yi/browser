'use strict';
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
esbuild.buildSync({
    absWorkingDir: root, entryPoints: ['ui/main.jsx'], bundle: true,
    outfile: 'renderer.js', format: 'iife', platform: 'browser', target: 'chrome140',
    minify: true, legalComments: 'eof', charset: 'utf8',
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: '/* Generated from ui/ by npm run build:ui. Do not edit directly. */' }
});
fs.renameSync(path.join(root, 'renderer.css'), path.join(root, 'style.css'));
console.log('Built offline Electron UI: renderer.js + style.css');
