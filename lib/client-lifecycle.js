'use strict';

// All exit entrypoints share one gate. A hidden window is NOT an exited client.
class ClientLifecycle {
    constructor({ manager, chooseClose, chooseFailure, reportError, hide, quit }) {
        Object.assign(this, { manager, chooseClose, chooseFailure, reportError, hide, quit });
        this.allowQuit = false;
        this.prompting = false;
        this.exiting = null;
    }
    async closeWindow() {
        if (this.allowQuit || this.prompting || this.exiting) return;
        this.prompting = true;
        try {
            const response = await this.chooseClose();
            if (response === 0) this.hide();
            else if (response === 1) await this.exit();
        } catch (error) { await this.reportError(error); }
        finally { this.prompting = false; }
    }
    exit({ interactive = true, finish = this.quit } = {}) {
        if (this.exiting) return this.exiting;
        if (this.allowQuit) return Promise.resolve(true);
        this.manager.beginShutdown(); // synchronous: even queued launch requests must stop
        this.exiting = (async () => {
            try {
                for (;;) {
                    let problem;
                    try {
                        const result = await this.manager.closeAllProfiles();
                        if (result.failed) throw Error('还有 ' + result.failed + ' 个浏览器环境未退出。');
                        await this.manager.waitForBrowserExit();
                    } catch (error) { problem = error; }
                    if (!problem) break;
                    if (!interactive) throw problem;
                    const response = await this.chooseFailure(problem);
                    if (response === 0) continue;
                    if (response !== 1) return false;
                    await this.manager.forceCloseAllProfiles();
                    await this.manager.waitForBrowserExit();
                    break;
                }
                this.allowQuit = true;
                try { await finish(); } catch (error) { this.allowQuit = false; throw error; }
                return true;
            } catch (error) {
                if (!interactive) throw error;
                await this.reportError(error);
                return false;
            } finally {
                if (!this.allowQuit) this.manager.cancelShutdown();
            }
        })();
        // Clear the gate after success AND rejection without an unhandled .finally promise.
        this.exiting.then(() => { this.exiting = null; }, () => { this.exiting = null; });
        return this.exiting;
    }
}
module.exports = { ClientLifecycle };
