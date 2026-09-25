// Puente seguro entre el proceso de renderizado y el sistema de archivos local.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rotastock', {
  isElectron: true,
  loadDB: () => ipcRenderer.invoke('db:load'),
  saveDB: (db) => ipcRenderer.invoke('db:save', db)
});
