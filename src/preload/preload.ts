import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { WledBridge } from '../shared/types';

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: WledBridge = {
  getSnapshot: () => ipcRenderer.invoke('snapshot'),
  onDevices: (cb) => on('devices', cb),
  onDevice: (cb) => on('device', cb),
  onToast: (cb) => on('toast', cb),
  getStatic: (id) => ipcRenderer.invoke('static', id),
  loadPalettes: (id) => ipcRenderer.invoke('palettes', id),
  send: (id, patch, key) => ipcRenderer.send('send', id, patch, key),
  sendAll: (patch) => ipcRenderer.send('send-all', patch),
  command: (id, patch) => ipcRenderer.invoke('command', id, patch),
  refresh: (id) => ipcRenderer.invoke('refresh', id),
  addDevice: (host) => ipcRenderer.invoke('add', host),
  removeDevice: (id) => ipcRenderer.invoke('remove', id),
  updateDevice: (id, changes) => ipcRenderer.invoke('update', id, changes),
  reorderDevices: (ids) => ipcRenderer.invoke('reorder', ids),
  localSubnets: () => ipcRenderer.invoke('subnets'),
  scan: (targets) => ipcRenderer.invoke('scan', targets),
  cancelScan: () => ipcRenderer.send('scan-cancel'),
  onScan: (cb) => on('scan', cb),
  setLiveView: (id) => ipcRenderer.send('live', id),
  onLive: (cb) => on('live', cb),
  openDevicePage: (id, page) => ipcRenderer.send('page', id, page),
  getSettings: () => ipcRenderer.invoke('settings-get'),
  setSettings: (patch) => ipcRenderer.invoke('settings-set', patch),
  onSettings: (cb) => on('settings', cb),
  showMain: (id) => ipcRenderer.send('show-main', id),
  onSelect: (cb) => on('select', cb),
  resizeFlyout: (height) => ipcRenderer.send('flyout-resize', height),
  hideFlyout: () => ipcRenderer.send('flyout-hide'),
  quit: () => ipcRenderer.send('quit'),
};

contextBridge.exposeInMainWorld('wled', bridge);
