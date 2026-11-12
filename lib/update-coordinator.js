'use strict';
const { compareVersions, validVersion, validRelease } = require('./update-protocol');
const RETRY_DELAYS = [5000, 15_000, 60_000];

class UpdateCoordinator {
    constructor({ updater, version, enabled, notify, log, canUpdate = () => true,
        setTimer = setTimeout, clearTimer = clearTimeout }) {
        Object.assign(this, { updater, version, enabled, notify, log, canUpdate, setTimer, clearTimer });
        this.status = { type: 'idle', revision: 0, pushConnection: 'disabled', automatic: false };
        this.inFlight = null; this.target = null; this.retries = 0; this.retryTimer = null; this.disposed = false;
        this.listeners = [];
        // No startup/interval check. Only a pushed release or the manual button
        // can initiate the metadata request; a pushed hint never changes the feed.
        updater.autoDownload = false;
        updater.autoInstallOnAppQuit = false;
        updater.allowDowngrade = false;
        this.listen('download-progress', info => {
            if (!this.isReady) this.publish('progress', { percent: Math.max(0, Math.min(100, Number(info.percent) || 0)) });
        });
        this.listen('update-downloaded', info => {
            this.cancelRetry();
            this.publish('ready', { version: info?.version || this.status.version, percent: 100, message: undefined });
        });
        this.listen('error', error => {
            // The check/download rejection is handled below; preserve READY when
            // a failed explicit install emits an error. Main handles that error.
            this.log.warn('Updater error', error);
        });
    }
    get isReady() { return this.status.type === 'ready'; }
    getState() { return { ...this.status }; }
    publish(type, data = {}) {
        if (this.disposed) return;
        this.status = { ...this.status, type, ...data, revision: this.status.revision + 1 };
        this.notify(this.getState());
    }
    connection(pushConnection) { this.publish(this.status.type, { pushConnection }); }
    listen(event, callback) { this.updater.on(event, callback); this.listeners.push([event, callback]); }
    cancelRetry() { if (this.retryTimer !== null) this.clearTimer(this.retryTimer); this.retryTimer = null; }
    receive(release) {
        if (this.disposed || !validRelease(release) || compareVersions(release.version, this.version) <= 0 || this.isReady) return;
        if (!this.target || compareVersions(release.version, this.target) > 0) {
            this.target = release.version; this.retries = 0; this.cancelRetry();
        } else if (compareVersions(release.version, this.target) < 0 || this.retryTimer !== null || this.inFlight || this.retries > RETRY_DELAYS.length) return;
        void this.check();
    }
    async check({ manual = false } = {}) {
        if (this.disposed || this.isReady || this.inFlight) return this.getState();
        if (!this.enabled) { this.publish('development', { automatic: !manual }); return this.getState(); }
        this.cancelRetry();
        if (manual) this.retries = 0;
        const target = this.target;
        this.publish('checking', { automatic: !manual, message: undefined, percent: undefined });
        this.inFlight = Promise.resolve().then(async () => {
            try {
                if (!this.canUpdate()) throw Error('客户端正在退出，请稍后重试。');
                const result = await this.updater.checkForUpdates();
                if (!result?.isUpdateAvailable) {
                    if (target) throw Error('已收到发布通知，更新源尚未就绪。');
                    this.publish('none'); return;
                }
                const found = result.updateInfo?.version;
                if (!validVersion(found) || compareVersions(found, this.version) <= 0 || (target && compareVersions(found, target) < 0)) {
                    throw Error('更新源版本与发布通知不一致。');
                }
                if (this.disposed) return;
                if (!this.canUpdate()) throw Error('客户端正在退出，请稍后重试。');
                this.publish('available', { version: found });
                await this.updater.downloadUpdate();
                if (!this.isReady && !this.disposed) throw Error('更新包尚未通过下载校验。');
            } catch (error) {
                if (!this.isReady) this.publish('error', { message: error.message || '更新失败，请稍后重试。' });
                this.log.warn('Update attempt failed', error);
            } finally {
                this.inFlight = null;
                if (!this.disposed && !this.isReady && this.target && this.target !== target) {
                    // A publication arriving during a manual/no-update request must
                    // not be lost. Drain that event, not a periodic version check.
                    queueMicrotask(() => { void this.check(); });
                } else if (!this.disposed && !this.isReady && this.target && this.status.type === 'error') {
                    const delay = RETRY_DELAYS[this.retries++];
                    // Bounded retries for THIS notified release, never version polling.
                    if (delay !== undefined) {
                        this.retryTimer = this.setTimer(() => { this.retryTimer = null; void this.check(); }, delay);
                        this.retryTimer?.unref?.();
                    }
                }
            }
        });
        await this.inFlight;
        return this.getState();
    }
    dispose() {
        this.disposed = true; this.cancelRetry();
        for (const [event, callback] of this.listeners) this.updater.removeListener(event, callback);
    }
}
module.exports = { UpdateCoordinator, RETRY_DELAYS };
