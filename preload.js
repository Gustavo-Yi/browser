const { contextBridge, ipcRenderer } = require('electron');

// Exposed API for the Sidebar UI
contextBridge.exposeInMainWorld('electronAPI', {
    getAccounts: () => ipcRenderer.send('get-accounts'),
    onAccountsList: (callback) => ipcRenderer.on('accounts-list', (_event, value) => callback(value)),
    switchAccount: (id) => ipcRenderer.send('switch-account', id),
    addAccount: (data) => ipcRenderer.send('add-account', data),
    updateAccount: (data) => ipcRenderer.send('update-account', data),
    setViewVisibility: (visible) => ipcRenderer.send('set-view-visibility', visible),
    testProxy: (proxyUrl) => ipcRenderer.invoke('test-proxy', proxyUrl),
    reloadAccount: (id) => ipcRenderer.send('reload-account', id),
    deleteAccount: (id) => ipcRenderer.send('delete-account', id),
    updateSidebarWidth: (width) => ipcRenderer.send('update-sidebar-width', width)
});

// Fingerprinting & Timezone Spoofing
ipcRenderer.on('set-timezone', (_event, timezone) => {
    try {
        // This is a common way to spoof timezone in the renderer
        // It's not perfect but works for standard Date usage
        const originalDateTimeFormat = Intl.DateTimeFormat;
        const originalDate = Date;

        // Override Intl.DateTimeFormat
        Intl.DateTimeFormat = function(locale, options) {
            const finalOptions = { ...options, timeZone: timezone };
            return new originalDateTimeFormat(locale, finalOptions);
        };
        Intl.DateTimeFormat.prototype = originalDateTimeFormat.prototype;
        Intl.DateTimeFormat.supportedLocalesOf = originalDateTimeFormat.supportedLocalesOf;

        // Override Date.prototype.getTimezoneOffset if needed
        // Note: This is more complex to do correctly because it depends on the actual time
        
        console.log(`[Anti-Fingerprint] Timezone set to: ${timezone}`);
    } catch (e) {
        console.error('Failed to spoof timezone:', e);
    }
});

// Additional stealth: WebRTC is already handled in main.js via setWebRTCIPHandlingPolicy
// More overrides can be added here (e.g. screen resolution, hardware concurrency)
