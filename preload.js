'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function subscribe(channel, callback) {
    if (typeof callback !== 'function') throw new TypeError('Expected a callback');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}
// No generic send/invoke API, file operations, arbitrary URLs or Electron events.
contextBridge.exposeInMainWorld('electronAPI', {
    getState: () => ipcRenderer.invoke('get-state'),
    getVersion: () => ipcRenderer.invoke('get-version'),
    addAccount: data => ipcRenderer.invoke('add-account', data),
    addBulkAccounts: data => ipcRenderer.invoke('add-bulk-accounts', data),
    updateAccount: data => ipcRenderer.invoke('update-account', data),
    deleteAccount: id => ipcRenderer.invoke('delete-account', id),
    launchProfile: id => ipcRenderer.invoke('launch-profile', id),
    closeProfile: id => ipcRenderer.invoke('close-profile', id),
    launchAllProfiles: () => ipcRenderer.invoke('launch-all-profiles'),
    closeAllProfiles: () => ipcRenderer.invoke('close-all-profiles'),
    openProfileFolder: id => ipcRenderer.invoke('open-profile-folder', id),
    openProfilesRoot: () => ipcRenderer.invoke('open-profiles-root'),
    selectChromePath: () => ipcRenderer.invoke('select-chrome-path'),
    openChromeDownload: () => ipcRenderer.invoke('open-chrome-download'),
    getUpdateState: () => ipcRenderer.invoke('get-update-state'),
    checkUpdate: () => ipcRenderer.invoke('check-update'),
    restartUpdate: () => ipcRenderer.invoke('restart-update'),
    onState: callback => subscribe('app-state', callback),
    onLaunchProgress: callback => subscribe('launch-progress', callback),
    onUpdate: callback => subscribe('update-status', callback)
});
