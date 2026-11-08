'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function powershell(script) {
    const { stdout } = await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
        Buffer.from("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; " + script, 'utf16le').toString('base64')],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || 'null');
}

function splitCommandLine(command) {
    const args = []; let token = ''; let quoted = false; let started = false;
    for (let i = 0; i < command.length;) {
        const ch = command[i];
        if (!quoted && /\s/.test(ch)) {
            if (started) args.push(token);
            token = ''; started = false; i++; continue;
        }
        if (ch === '\\') {
            let count = 0;
            while (command[i] === '\\') { count++; i++; }
            if (command[i] === '"') {
                token += '\\'.repeat(Math.floor(count / 2));
                if (count % 2) token += '"'; else quoted = !quoted;
                i++;
            } else token += '\\'.repeat(count);
            started = true; continue;
        }
        if (ch === '"') { quoted = !quoted; started = true; i++; continue; }
        token += ch; started = true; i++;
    }
    if (started) args.push(token);
    return args;
}

function getProfileArgument(command) {
    const args = splitCommandLine(command || '');
    if (args.some(arg => arg === '--type' || arg.startsWith('--type='))) return null;
    const values = [];
    for (let i = 1; i < args.length; i++) {
        if (args[i] === '--user-data-dir') values.push(args[++i]);
        else if (args[i].startsWith('--user-data-dir=')) values.push(args[i].slice(16));
    }
    return values.length === 1 && values[0] && path.win32.isAbsolute(values[0]) ? values[0] : null;
}

function samePath(a, b) {
    return typeof a === 'string' && typeof b === 'string' &&
        path.win32.normalize(a).replace(/[\\/]+$/, '').toLowerCase() === path.win32.normalize(b).replace(/[\\/]+$/, '').toLowerCase();
}

function identity(record) {
    return record.pid + '|' + record.createdAt + '|' + record.executable.toLowerCase();
}

async function listProcesses(profilesRoot) {
    if (process.platform !== 'win32') throw new Error('当前进程管理仅支持 Windows。');
    const encoded = Buffer.from(path.resolve(profilesRoot)).toString('base64');
    const rows = await powershell(`
        $root=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));
        $rows=@(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($root,[StringComparison]::OrdinalIgnoreCase) -ge 0
        } | ForEach-Object { [pscustomobject]@{
            pid=[int]$_.ProcessId; executable=$_.ExecutablePath; commandLine=$_.CommandLine;
            createdAt=$_.CreationDate.ToUniversalTime().ToString('o')
        }});
        ConvertTo-Json -InputObject $rows -Compress
    `);
    return (rows || []).flatMap(row => {
        const profile = getProfileArgument(row.commandLine);
        if (profile && samePath(path.win32.dirname(profile), profilesRoot) && (!row.executable || !row.createdAt)) {
            throw new Error('无法读取该环境的进程身份，请核对 Chrome 与客户端的运行权限。');
        }
        if (!profile || !row.executable || !row.createdAt || !Number.isInteger(row.pid) || row.pid <= 0 ||
            path.win32.basename(row.executable).toLowerCase() !== 'chrome.exe' ||
            !samePath(path.win32.dirname(profile), profilesRoot)) return [];
        return [{ ...row, profile }];
    });
}

async function requestClose(record) {
    const encoded = Buffer.from(JSON.stringify(record)).toString('base64');
    // Revalidate identity before WM_CLOSE; never force-kill a database writer.
    return powershell(`
        $expected=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json);
        $current=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$expected.pid);
        if (!$current) { '{"requested":false,"gone":true}' ; exit 0 }
        if ($current.CreationDate.ToUniversalTime().ToString('o') -cne $expected.createdAt -or
            $current.ExecutablePath -ine $expected.executable -or $current.CommandLine -cne $expected.commandLine) {
            throw '浏览器进程身份已改变，未发送关闭命令。'
        }
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class YTWindowClose {
    public delegate bool Callback(IntPtr h, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr p);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    public static int Close(uint pid) {
        int count=0;
        EnumWindows((h,p)=>{ uint owner; GetWindowThreadProcessId(h,out owner);
            if(owner==pid && PostMessage(h,0x0010,IntPtr.Zero,IntPtr.Zero)) count++;
            return true;
        }, IntPtr.Zero);
        return count;
    }
}
'@;
        $count=[YTWindowClose]::Close([uint32]$expected.pid);
        @{requested=($count -gt 0);windows=$count} | ConvertTo-Json -Compress
    `);
}

module.exports = { listProcesses, requestClose, getProfileArgument, splitCommandLine, samePath, identity };
