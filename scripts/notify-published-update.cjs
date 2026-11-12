'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const yaml = require('js-yaml');
const { verify } = require('../test/cloud-push-smoke.cjs');
const { validVersion } = require('../lib/update-protocol');
async function main() {
    const version = (process.env.YT_TARGET_VERSION || '').replace(/^v/, '');
    if (!validVersion(version)) throw Error('Invalid target version');
    if (!process.env.YT_PUSH_URL || !process.env.YT_PUSH_TOKEN) throw Error('Push publication configuration missing');
    const repo = 'Gustavo-Yi/browser', tag = 'v' + version;
    const gh = args => execFileSync('gh', args, { encoding: 'utf8', windowsHide: true, timeout: 90_000 });
    const release = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,isPrerelease,tagName,assets']));
    if (release.isDraft || release.isPrerelease || release.tagName !== tag) throw Error('Only a published stable release may be pushed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-release-notify-'));
    const manifestFile = path.join(dir, 'latest.yml');
    gh(['release', 'download', tag, '--repo', repo, '--pattern', 'latest.yml', '--output', manifestFile]);
    const manifest = yaml.load(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.version !== version) throw Error('Release manifest version mismatch');
    const entry = manifest.files?.find(file => file.url.endsWith('.exe'));
    const installer = entry && release.assets.find(asset => asset.name === decodeURIComponent(entry.url));
    if (!installer || installer.size !== entry.size || !/^[A-Za-z0-9+/]{86}==$/.test(entry.sha512)) throw Error('Installer metadata incomplete');
    const result = await verify(process.env.YT_PUSH_URL, version, process.env.YT_PUSH_TOKEN);
    fs.mkdirSync('update-verification', { recursive: true });
    fs.writeFileSync('update-verification/cloud-push.json', JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
