// Headless Electron relay harness. Both WebRTC peers run in one process and are
// forced through a TURN relay. No endpoint, relay IP, username, or credential is
// stored in this repository.
//
// Preferred configuration (fetches short-lived credentials):
//   YSHARE_TURN_HTTP_URL=http://127.0.0.1:8443/turn
// The signaling server must explicitly enable that dev/test endpoint with
// YSHARE_ENABLE_TURN_HTTP=1. An optional reverse-proxy token can be supplied as
// YSHARE_TURN_HTTP_BEARER.
//
// Direct environment fallback:
//   YSHARE_TURN_URLS=turn:host:3478,turn:host:3478?transport=tcp
//   YSHARE_TURN_USERNAME=...
//   YSHARE_TURN_CREDENTIAL=...
//
// Harness query options remain in HQ, for example:
//   HQ="pc=8&ch=1&chunk=65536&mb=20&t=both"

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function parseUrls(raw) {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  return trimmed.split(',').map((value) => value.trim()).filter(Boolean);
}

function validateTurnConfig(value) {
  const urls = Array.isArray(value?.urls) ? value.urls : [value?.urls].filter(Boolean);
  if (urls.length === 0 || urls.length > 8 || !urls.every((url) => typeof url === 'string' && /^turns?:/i.test(url))) {
    throw new Error('TURN configuration must contain valid turn: or turns: URLs');
  }
  if (typeof value.username !== 'string' || !value.username || value.username.length > 512) {
    throw new Error('TURN username is missing or invalid');
  }
  if (typeof value.credential !== 'string' || !value.credential || value.credential.length > 512) {
    throw new Error('TURN credential is missing or invalid');
  }
  return { urls, username: value.username, credential: value.credential };
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function loadTurnConfig() {
  const endpoint = process.env.YSHARE_TURN_HTTP_URL;
  if (endpoint) {
    const parsed = new URL(endpoint);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('YSHARE_TURN_HTTP_URL must use http or https');
    const headers = { accept: 'application/json' };
    if (process.env.YSHARE_TURN_HTTP_BEARER) {
      headers.authorization = `Bearer ${process.env.YSHARE_TURN_HTTP_BEARER}`;
    }
    const response = await fetchWithTimeout(parsed.href, {
      method: 'GET',
      cache: 'no-store',
      headers,
    }, 8000);
    if (!response.ok) throw new Error(`TURN endpoint returned HTTP ${response.status}`);
    return validateTurnConfig(await response.json());
  }

  const direct = {
    urls: parseUrls(process.env.YSHARE_TURN_URLS || ''),
    username: process.env.YSHARE_TURN_USERNAME || '',
    credential: process.env.YSHARE_TURN_CREDENTIAL || '',
  };
  if (direct.urls.length && direct.username && direct.credential) return validateTurnConfig(direct);

  throw new Error(
    'Set YSHARE_TURN_HTTP_URL for short-lived test credentials, or set '
    + 'YSHARE_TURN_URLS, YSHARE_TURN_USERNAME, and YSHARE_TURN_CREDENTIAL',
  );
}

function emit(message) {
  process.stdout.write(`${message}\n`);
}

app.whenReady().then(async () => {
  let turnConfig;
  try {
    turnConfig = await loadTurnConfig();
  } catch (error) {
    emit(`[H] CONFIG ERROR: ${error.message}`);
    emit('[H] HARNESS_DONE');
    app.quit();
    return;
  }

  ipcMain.handle('yshare-harness:get-turn-config', () => turnConfig);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  win.webContents.on('console-message', (...args) => {
    let message = '';
    for (const arg of args) {
      if (typeof arg === 'string') { message = arg; break; }
      if (arg && typeof arg.message === 'string') { message = arg.message; break; }
    }
    if (!message) return;
    emit(message);
    if (message.includes('HARNESS_DONE')) setTimeout(() => app.quit(), 250);
  });

  const search = process.env.HQ || 'pc=1&ch=1&chunk=65536&mb=20&t=both';
  await win.loadFile(path.join(__dirname, process.env.HFILE || 'harness.html'), { search });

  setTimeout(() => {
    emit('[H] TIMEOUT - quitting');
    app.quit();
  }, 240000).unref();
});

app.on('window-all-closed', () => app.quit());
