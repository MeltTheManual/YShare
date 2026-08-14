'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yshareHarness', Object.freeze({
  getTurnConfig: () => ipcRenderer.invoke('yshare-harness:get-turn-config'),
}));
