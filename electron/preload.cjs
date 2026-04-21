const { contextBridge } = require('electron');

// Expose a flag so the renderer knows it's running in Electron
contextBridge.exposeInMainWorld('electronAPI', {
    isElectron: true,
    platform: process.platform,
});
