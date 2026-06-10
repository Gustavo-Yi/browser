const { contextBridge, ipcRenderer } = require('electron');

const electronAPI = {
    getAccounts: () => ipcRenderer.send('get-accounts'),
    onAccountsList: (callback) => ipcRenderer.on('accounts-list', (_event, value) => callback(value)),
    addAccount: (data) => ipcRenderer.send('add-account', data),
    addBulkAccounts: (data) => ipcRenderer.send('add-bulk-accounts', data),
    updateAccount: (data) => ipcRenderer.send('update-account', data),
    openProfileFolder: (id) => ipcRenderer.send('open-profile-folder', id),
    reloadAccount: (id) => ipcRenderer.send('reload-account', id),
    deleteAccount: (id) => ipcRenderer.send('delete-account', id)
};

if (process.contextIsolated) {
    contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} else {
    window.electronAPI = electronAPI;
}
