// YShare — Electron main process (the "Engine room").
// Owns ALL disk I/O + the file-picker dialog. WebRTC lives in the renderer; this
// talks to it over IPC. Security: context isolation ON, nodeIntegration OFF.
//
// Stage 1 (multi-connection): the file is split into N contiguous ranges, one per
// parallel peer connection. Reads are POSITIONED (random-access) so ranges can be
// pulled in parallel; writes are POSITIONED so out-of-order pieces land at the right
// offset. Integrity = a single whole-file SHA-256 on each side (sender hashes the
// source; receiver hashes the reassembled file), compared at the end.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { isExpectedRendererUrl, isTrustedRendererEvent } = require('./main-security');

const rendererEntryPath = path.join(__dirname, 'renderer', 'index.html');
const rendererEntryUrl = pathToFileURL(rendererEntryPath).href;
let trustedWebContents = null;

function trustedHandle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedRendererEvent(event, trustedWebContents, rendererEntryUrl)) {
      throw new Error('untrusted renderer IPC rejected');
    }
    return listener(event, ...args);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1060,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#e9e1cf',   /* COURIER paper — no dark flash before first paint */
    title: 'YShare',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  trustedWebContents = win.webContents;
  win.webContents.once('destroyed', () => {
    if (trustedWebContents === win.webContents) trustedWebContents = null;
  });
  const blockUnexpectedNavigation = (event, legacyUrl) => {
    const targetUrl = typeof legacyUrl === 'string' ? legacyUrl : event && event.url;
    if (!isExpectedRendererUrl(targetUrl, rendererEntryUrl)) event.preventDefault();
  };
  win.webContents.on('will-navigate', blockUnexpectedNavigation);
  win.webContents.on('will-frame-navigate', blockUnexpectedNavigation);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // YSHARE_TEST_HIDDEN=1 keeps the window invisible for automated self-tests
  // (driven via --remote-debugging-port) so tests never steal the owner's focus.
  // YSHARE_TEST_OFFSCREEN=1 parks it far off-screen instead, WITHOUT focus:
  // hidden windows never paint, so screenshot-based UI checks need this mode.
  if (process.env.YSHARE_TEST_OFFSCREEN === '1') {
    win.setPosition(-4200, 100);
    win.once('ready-to-show', () => win.showInactive());
  } else if (process.env.YSHARE_TEST_HIDDEN !== '1') {
    win.once('ready-to-show', () => win.show());
  }
  win.loadFile(rendererEntryPath);

  // A renderer reload normally asks us to clean up first, but closing the window,
  // a renderer crash, or an OS shutdown can bypass renderer JavaScript entirely.
  // Hold the close just long enough to close handles and remove partial downloads.
  let closingAfterCleanup = false;
  win.on('close', (event) => {
    if (closingAfterCleanup) return;
    event.preventDefault();
    closingAfterCleanup = true;
    cleanupTransfers().catch((err) => console.error('close cleanup failed:', err))
      .finally(() => { if (!win.isDestroyed()) win.destroy(); });
  });
  win.webContents.on('render-process-gone', () => {
    cleanupTransfers().catch((err) => console.error('renderer cleanup failed:', err));
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Settings — one small JSON file in userData (no DB, no dependency). Holds:
//   downloadDir     where received files are saved
//   signalEndpoint  the Quick Connect signaling server this install uses
// YShare ships with NO server address, so signalEndpoint starts empty and quick
// connect stays off until the person sets one (docs/SELF-HOSTING.md).
// ---------------------------------------------------------------------------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}

// Returns whether the write actually landed. Callers that tell the user
// something was saved MUST check this: claiming "saved" after a failed write
// means the setting quietly disappears at the next launch.
function saveSettings(s) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
    return true;
  } catch {
    return false;
  }
}

// The folder received files land in: the user's choice if it still exists,
// otherwise the OS Downloads folder (also the out-of-box default).
function downloadDir() {
  const s = loadSettings();
  if (s.downloadDir && fs.existsSync(s.downloadDir)) return s.downloadDir;
  return app.getPath('downloads');
}

trustedHandle('get-download-dir', () => downloadDir());

trustedHandle('pick-download-dir', async () => {
  // YSHARE_TEST_PICKDIR=<path> skips the dialog for automated self-tests.
  if (process.env.YSHARE_TEST_PICKDIR) {
    const p = process.env.YSHARE_TEST_PICKDIR;
    saveSettings({ ...loadSettings(), downloadDir: p });
    return p;
  }
  const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  const p = res.filePaths[0];
  saveSettings({ ...loadSettings(), downloadDir: p });
  return p;
});

trustedHandle('reset-download-dir', () => {
  const s = loadSettings();
  delete s.downloadDir;
  saveSettings(s);
  return app.getPath('downloads');
});

// --- Quick Connect server ---------------------------------------------------
// Validation lives in the shared engine so desktop and Android agree on exactly
// which addresses are acceptable. Cleartext ws:// is allowed only to loopback,
// which is also all the renderer's Content-Security-Policy permits.
const engine = require('../shared/engine.js');

function storedSignalValue() {
  const s = loadSettings();
  return typeof s.signalEndpoint === 'string' ? s.signalEndpoint : '';
}

// One shape for the renderer: what is stored, whether it is usable, and why not.
function signalState(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { value: '', display: '', ok: false, reason: '' };
  const parsed = engine.parseSignalEndpoint(raw);
  if (!parsed) {
    return {
      value: raw,
      display: '',
      ok: false,
      reason: 'that address does not look right — it should look like wss://example.com:8443',
    };
  }
  const issue = engine.signalEndpointIssue(parsed, false);
  if (issue) return { value: raw, display: parsed.display, ok: false, reason: issue };
  return { value: raw, display: parsed.display, ok: true, reason: '' };
}

trustedHandle('get-signal-endpoint', () => signalState(storedSignalValue()));

trustedHandle('set-signal-endpoint', (_event, value) => {
  const state = signalState(typeof value === 'string' ? value : '');
  if (!state.ok) return state;                 // nothing is stored until it is valid
  if (!saveSettings({ ...loadSettings(), signalEndpoint: state.value })) {
    // Usable right now, but it will not survive a restart. Say so instead of
    // pretending, and leave the endpoint active for this session.
    return { ...state, stored: false, reason: 'saved for now, but this device would not let YShare remember it' };
  }
  return { ...state, stored: true };
});

trustedHandle('clear-signal-endpoint', () => {
  const s = loadSettings();
  delete s.signalEndpoint;
  const stored = saveSettings(s);
  return {
    value: '',
    display: '',
    ok: false,
    stored,
    // A failed delete means the old address returns at the next launch. That is a
    // privacy surprise, not a cosmetic one, so it must not be reported as removed.
    reason: stored ? '' : 'removed for now, but this device would not let YShare forget it',
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Stream a whole file and return its SHA-256 (hex). Bounded memory (never loads
// the whole file). Used for the final integrity check on BOTH sides.
function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

const MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024 * 1024;

function checkedInt(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function checkedHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error('invalid SHA-256');
  }
  return value.toLowerCase();
}

function checkedOwner(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error('invalid transfer owner');
  }
  return value;
}

// Main-process validation is deliberately repeated at the filesystem boundary.
// Renderer validation protects the protocol; this protects disk I/O even if a
// future renderer regression invokes IPC with unsafe values.
function safeLeafName(value, fallback) {
  const raw = typeof value === 'string' ? value : '';
  if (!raw || raw.length > 1024) throw new Error('invalid file name');
  let name = raw
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  if (!name || name === '.' || name === '..') name = fallback;
  const stem = name.split('.')[0];
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) name = '_' + name;
  if (name.length > 240) name = name.slice(0, 240).replace(/[. ]+$/g, '');
  if (!name) throw new Error('invalid file name');
  return name;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error('invalid relative path');
  }
  const normalized = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('absolute path rejected');
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('unsafe path segment');
  }
  return parts.map((part) => safeLeafName(part, 'item')).join('/');
}

async function writeAll(handle, buffer, offset) {
  let written = 0;
  while (written < buffer.length) {
    const res = await handle.write(buffer, written, buffer.length - written, offset + written);
    if (!res || res.bytesWritten <= 0) throw new Error('disk write stopped early');
    written += res.bytesWritten;
  }
}

// Publish a verified .part without ever replacing an existing destination.
// A hard link is atomic and exclusive on normal desktop filesystems. Volumes
// without hard links use COPYFILE_EXCL: slower, but still exclusive and safe.
async function publishPart(partPath, finalPath) {
  try {
    await fs.promises.link(partPath, finalPath);
    const removed = await unlinkWithRetry(partPath);
    if (!removed) {
      await unlinkWithRetry(finalPath);
      throw new Error('could not remove the temporary file after publishing');
    }
  } catch (err) {
    const fallback = process.platform === 'win32'
      && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN'].includes(err && err.code);
    if (!fallback) throw err;
    try {
      await fs.promises.copyFile(partPath, finalPath, fs.constants.COPYFILE_EXCL);
      const removed = await unlinkWithRetry(partPath);
      if (!removed) throw new Error('could not remove the temporary file after publishing');
    } catch (copyErr) {
      // EEXIST means somebody else owned the destination before our copy. For
      // every other failure COPYFILE_EXCL may have created a partial file, so
      // remove only that file before surfacing the failure.
      if (!copyErr || copyErr.code !== 'EEXIST') await unlinkWithRetry(finalPath);
      throw copyErr;
    }
  }
}

async function unlinkWithRetry(filePath) {
  if (!filePath) return true;
  for (let i = 0; i < 15; i++) {
    try { await fs.promises.unlink(filePath); return true; }
    catch (err) {
      if (err.code === 'ENOENT') return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return false;
}

async function rmTreeWithRetry(dirPath) {
  if (!dirPath) return true;
  for (let i = 0; i < 15; i++) {
    try { await fs.promises.rm(dirPath, { recursive: true, force: true }); return true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Disk I/O over IPC. One read handle (sender) + one write handle (receiver) per
// process; v1 is one active transfer at a time.
// ---------------------------------------------------------------------------

let readSession = null;  // { owner, handle }; owner binding blocks stale async callbacks
let readEpoch = 0;
let pendingReadOwner = null;
let singleReceive = null; // { owner, handle, partPath, finalPath, size, finishPromise, published }

async function openReadSource(owner, filePath) {
  const token = ++readEpoch;
  pendingReadOwner = owner;
  const previous = readSession;
  readSession = null;
  if (previous) await previous.handle.close().catch(() => {});
  const handle = await fs.promises.open(filePath, 'r');
  if (token !== readEpoch) {
    await handle.close().catch(() => {});
    throw new Error('source open was replaced by another transfer');
  }
  readSession = { owner, handle };
  pendingReadOwner = null;
  return true;
}

async function closeReadSource(owner, force = false) {
  if (force || pendingReadOwner === owner) {
    readEpoch += 1;
    pendingReadOwner = null;
  }
  const session = readSession;
  if (!session || (!force && session.owner !== owner)) return true;
  readSession = null;
  await session.handle.close().catch(() => {});
  return true;
}

// --- Sender side: pick + read the source file (positioned, parallel-safe) ---

let pickedFileSelection = null;
const fileSendOwners = new Map(); // transfer id -> selected source path snapshot

trustedHandle('pick-file', async () => {
  // YSHARE_TEST_PICK=<path> skips the dialog for automated self-tests (no focus steal).
  if (process.env.YSHARE_TEST_PICK) {
    const p = process.env.YSHARE_TEST_PICK;
    const st = await fs.promises.stat(p);
    pickedFileSelection = { path: p, name: path.basename(p), size: st.size };
    return { name: pickedFileSelection.name, size: pickedFileSelection.size };
  }
  const res = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (res.canceled || res.filePaths.length === 0) return null;
  const p = res.filePaths[0];
  const st = await fs.promises.stat(p);
  pickedFileSelection = { path: p, name: path.basename(p), size: st.size };
  return { name: pickedFileSelection.name, size: pickedFileSelection.size };
});

trustedHandle('begin-file-send', (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  if (!pickedFileSelection) throw new Error('no source file is selected');
  fileSendOwners.set(owner, pickedFileSelection);
  return true;
});

trustedHandle('end-file-send', (_e, ownerId) => {
  fileSendOwners.delete(checkedOwner(ownerId));
  return true;
});

trustedHandle('open-read', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const source = fileSendOwners.get(owner);
  if (!source) throw new Error('source file belongs to another transfer');
  return openReadSource(owner, source.path);
});

// Positioned read of one chunk. Safe for concurrent disjoint reads (pread).
trustedHandle('read-chunk', async (_e, ownerId, offset, length) => {
  const owner = checkedOwner(ownerId);
  const session = readSession;
  if (!session || session.owner !== owner) throw new Error('source file belongs to another transfer');
  checkedInt(offset, 'read offset');
  checkedInt(length, 'read length', 16 * 1024 * 1024);
  const buf = Buffer.alloc(length);
  const { bytesRead } = await session.handle.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead); // arrives in the renderer as a Uint8Array
});

trustedHandle('close-read', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  return closeReadSource(owner, false);
});

// Whole-file hash of the owner-bound SOURCE (sender computes it up front).
trustedHandle('hash-file', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const source = fileSendOwners.get(owner);
  if (!source) throw new Error('source file belongs to another transfer');
  return hashFile(source.path);
});

// App version — single source of truth is package.json (app.getVersion reads it).
trustedHandle('app-version', () => app.getVersion());
trustedHandle('app-is-packaged', () => app.isPackaged);

// A visible renderer Accept claims the next receiver owner before any metadata
// can open files. This gives main an ordering token: delayed IPC from an older
// transfer can never abort or overwrite the new owner's session.
let activeReceiveOwner = null;
let receiveEpoch = 0;
let activeReceiveEpoch = 0;
function receiveClaimIsCurrent(owner, epoch) {
  return activeReceiveOwner === owner && activeReceiveEpoch === epoch && receiveEpoch === epoch;
}

function assertReceiveClaim(owner, epoch) {
  if (!receiveClaimIsCurrent(owner, epoch)) throw new Error('receive was replaced by a newer transfer');
}

trustedHandle('begin-receive', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  if (activeReceiveOwner === owner && activeReceiveEpoch === receiveEpoch) return true;
  const token = ++receiveEpoch;
  activeReceiveOwner = null;
  activeReceiveEpoch = 0;
  const [singleOk, folderOk] = await Promise.all([
    abortSingleReceive(null, true),
    abortFolderReceive(null, true),
  ]);
  if (!singleOk || !folderOk) throw new Error('could not clean up the previous receive');
  if (token !== receiveEpoch) throw new Error('receive accept was replaced by a newer transfer');
  activeReceiveOwner = owner;
  activeReceiveEpoch = token;
  return true;
});

// --- Receiver side: write the incoming file (positioned, parallel-safe) -----

trustedHandle('open-write', async (_e, ownerId, name, size) => {
  const owner = checkedOwner(ownerId);
  if (activeReceiveOwner !== owner) throw new Error('receive was not accepted by this transfer');
  const epoch = receiveEpoch;
  assertReceiveClaim(owner, epoch);
  if (singleReceive || folderReceive) throw new Error('a receive destination is already reserved');
  const checkedSize = checkedInt(size, 'file size', MAX_TRANSFER_BYTES);
  const downloads = downloadDir();   // user's chosen folder, or OS Downloads
  const safe = safeLeafName(name, 'received.bin');
  // Never overwrite an existing download: photo.jpg -> photo (1).jpg, etc.
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let candidate = path.join(downloads, safe);
  for (let n = 1; fs.existsSync(candidate) || fs.existsSync(candidate + '.part'); n++) {
    candidate = path.join(downloads, `${base} (${n})${ext}`);
  }
  const session = {
    owner,
    handle: null,
    partPath: candidate + '.part',
    finalPath: candidate,
    size: checkedSize,
    finishPromise: null,
    published: false,
    pendingWrites: new Set(),
    aborting: false,
    createdByThisCall: false,
  };
  // Reserve synchronously, before fs.open yields. A duplicate IPC call can now
  // only be rejected; it cannot race us and later delete our .part file.
  singleReceive = session;
  try {
    session.handle = await fs.promises.open(session.partPath, 'wx');
    session.createdByThisCall = true;
    if (singleReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
      await session.handle.close().catch(() => {});
      session.handle = null;
      await unlinkWithRetry(session.partPath);
      throw new Error('receive was replaced by a newer transfer');
    }
    // Preallocate to the exact size so positioned writes cannot extend the file.
    await session.handle.truncate(checkedSize);
    if (singleReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
      await session.handle.close().catch(() => {});
      session.handle = null;
      await unlinkWithRetry(session.partPath);
      throw new Error('receive was replaced by a newer transfer');
    }
    return { partPath: session.partPath, finalPath: session.finalPath };
  } catch (err) {
    try { if (session.handle) await session.handle.close(); } catch {}
    session.handle = null;
    const removed = !session.createdByThisCall || await unlinkWithRetry(session.partPath);
    if (singleReceive === session && removed) singleReceive = null;
    if (!removed) throw new Error(`${err.message || err}; partial-file cleanup failed`);
    throw err;
  }
});

// Positioned write of one chunk at its absolute file offset. Safe for concurrent
// disjoint writes (pwrite) — the N connections write to non-overlapping regions.
trustedHandle('write-chunk-at', async (_e, ownerId, offset, chunk) => {
  const owner = checkedOwner(ownerId);
  const session = singleReceive;
  if (!session || session.owner !== owner || !session.handle || session.finishPromise || session.aborting) {
    throw new Error('incoming file belongs to another transfer or is already finalizing');
  }
  checkedInt(offset, 'write offset', session.size);
  const buf = Buffer.from(chunk);
  if (buf.length === 0 || offset + buf.length > session.size) {
    throw new Error('write exceeds declared file size');
  }
  const writing = writeAll(session.handle, buf, offset);
  session.pendingWrites.add(writing);
  try { await writing; return true; }
  finally { session.pendingWrites.delete(writing); }
});

// Close, hash, and publish the verified file. Ownership is deliberately retained
// until complete-write so a renderer Cancel during hashing/rename can still call
// abort-write and remove either the .part or newly published final file.
trustedHandle('finish-write', async (_e, ownerId, expectedHash) => {
  const owner = checkedOwner(ownerId);
  const expected = checkedHash(expectedHash);
  const session = singleReceive;
  if (!session || session.owner !== owner || session.aborting) {
    return { ok: false, hash: null, path: null, error: 'incoming file belongs to another transfer' };
  }
  if (session.finishPromise) return session.finishPromise;
  session.finishPromise = (async () => {
    try {
      if (!session.handle) throw new Error('incoming file is not open');
      await Promise.all([...session.pendingWrites]);
      await session.handle.close();
      session.handle = null;
      const stat = await fs.promises.stat(session.partPath);
      if (stat.size !== session.size) throw new Error('received file size does not match the offer');
      const got = await hashFile(session.partPath);
      if (got !== expected) {
        return { ok: false, hash: got, path: null, error: 'integrity check failed' };
      }
      await publishPart(session.partPath, session.finalPath);
      session.partPath = null;
      session.published = true;
      return { ok: true, hash: got, path: session.finalPath };
    } catch (err) {
      return { ok: false, hash: null, path: null, error: err.message || String(err) };
    }
  })();
  return session.finishPromise;
});

trustedHandle('complete-write', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const session = singleReceive;
  if (!session || session.owner !== owner || !session.finishPromise || session.aborting) {
    throw new Error('completed file belongs to another transfer');
  }
  const result = await session.finishPromise;
  if (!result || !result.ok || !session.published) throw new Error('file did not finish successfully');
  if (singleReceive !== session) throw new Error('completed file ownership changed');
  singleReceive = null;
  releaseReceiveOwner(owner);
  return result.path;
});

// Abort/cleanup a partial or just-published download. Waiting for finishPromise
// serializes Cancel against hash/rename; owner matching blocks stale transfers.
async function abortSingleReceive(ownerId, force = false) {
  const session = singleReceive;
  if (!session) return true;
  if (!force && session.owner !== ownerId) return true;
  session.aborting = true;
  if (session.finishPromise) await session.finishPromise.catch(() => {});
  else await Promise.allSettled([...session.pendingWrites]);
  try { if (session.handle) await session.handle.close(); } catch {}
  session.handle = null;
  const partRemoved = await unlinkWithRetry(session.partPath);
  const finalRemoved = session.published ? await unlinkWithRetry(session.finalPath) : true;
  const removed = partRemoved && finalRemoved;
  if (removed && singleReceive === session) singleReceive = null;
  return removed;
}

trustedHandle('abort-write', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const removed = await abortSingleReceive(owner, false);
  releaseReceiveOwner(owner);
  return removed;
});

// ===========================================================================
// FOLDER TRANSFER (CHUNK D) — send a whole folder as a recreated folder.
// Reuses the single-file machinery: files are streamed ONE AT A TIME, each split
// across the N connections (so the sender keeps ONE read handle, positioned reads
// of the current file). The receiver recreates the directory tree and verifies
// each file's SHA-256 before renaming it into place. Path traversal is blocked.
// The single-file handlers above are untouched.
// ===========================================================================

// --- Sender: scan a folder into a manifest (abs paths kept main-side) --------
let folderManifest = null;   // { name, files: [{ relPath, absPath, size }], totalSize }
const folderSendOwners = new Map(); // transfer id -> immutable manifest snapshot

// Stat files in PARALLEL within each directory (much faster than one-at-a-time on
// big folders). Subdirectories are walked after, depth-first.
async function scanFolder(root) {
  const files = [];
  async function walk(dir, rel) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const subdirs = [];
    await Promise.all(entries.map(async (e) => {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;   // forward slashes in the manifest
      if (e.isDirectory()) subdirs.push([abs, r]);
      else if (e.isFile()) {
        try { const st = await fs.promises.stat(abs); files.push({ relPath: r, absPath: abs, size: st.size }); }
        catch {}   // unreadable entry — skip rather than fail the whole folder
      }
      // symlinks / special files are skipped
    }));
    for (const [abs, r] of subdirs) await walk(abs, r);
  }
  await walk(root, '');
  return files;
}

// Pick the folder — returns only its display name IMMEDIATELY (the absolute path
// stays main-side), so the renderer
// can show what was chosen at once and put up a "scanning…" note while the (possibly
// slow) recursive scan runs as a separate step below.
let pendingFolderPath = null;
trustedHandle('pick-folder', async () => {
  // YSHARE_TEST_PICKFOLDER=<path> skips the dialog for automated self-tests.
  let folderPath;
  if (process.env.YSHARE_TEST_PICKFOLDER) {
    folderPath = process.env.YSHARE_TEST_PICKFOLDER;
  } else {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (res.canceled || res.filePaths.length === 0) return null;
    folderPath = res.filePaths[0];
  }
  pendingFolderPath = folderPath;
  return { name: path.basename(folderPath) };
});

// Scan the chosen folder into the manifest (abs paths stay main-side). Separate
// from pick-folder so the UI shows immediate feedback during a big scan.
trustedHandle('scan-folder', async () => {
  const root = pendingFolderPath;
  if (!root) throw new Error('no folder to scan');
  const files = await scanFolder(root);
  if (pendingFolderPath !== root) throw new Error('folder selection changed during the scan');
  pendingFolderPath = null;
  const totalSize = files.reduce((a, f) => a + f.size, 0);
  folderManifest = { name: path.basename(root), files, totalSize };
  // The renderer only needs relPath + size (abs paths stay main-side).
  return {
    name: folderManifest.name,
    count: files.length,
    totalSize,
    files: files.map((f) => ({ relPath: f.relPath, size: f.size })),
  };
});

trustedHandle('begin-folder-send', (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  if (!folderManifest) throw new Error('no folder manifest is available');
  folderSendOwners.set(owner, folderManifest);
  return true;
});

trustedHandle('end-folder-send', (_e, ownerId) => {
  folderSendOwners.delete(checkedOwner(ownerId));
  return true;
});

// Open the current source file BY INDEX (into the same readHandle the single-file
// path uses) so read-chunk / close-read work unchanged for each folder file.
trustedHandle('open-read-file', async (_e, ownerId, idx) => {
  const owner = checkedOwner(ownerId);
  const manifest = folderSendOwners.get(owner);
  if (!manifest || !manifest.files[idx]) throw new Error('bad file index');
  return openReadSource(owner, manifest.files[idx].absPath);
});

// Whole-file hash of source file BY INDEX (sender's per-file expected hash).
trustedHandle('hash-file-idx', async (_e, ownerId, idx) => {
  const owner = checkedOwner(ownerId);
  if (!readSession || readSession.owner !== owner) throw new Error('source folder belongs to another transfer');
  const manifest = folderSendOwners.get(owner);
  if (!manifest || !manifest.files[idx]) throw new Error('bad file index');
  return hashFile(manifest.files[idx].absPath);
});

// --- Receiver: recreate the folder + write its files (verified, safe) --------
// One owner-bound session prevents an old transfer's delayed writes/finalizers
// from touching a newer folder.
let folderReceive = null; // { owner, base, files, paths, finishPromises }

// Resolve a sender-supplied relative path safely UNDER base — blocks "../" escapes,
// absolute paths, and drive letters. Returns null if the path tries to escape.
function safeJoin(base, relPath) {
  const cleaned = String(relPath).replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  const full = path.resolve(base, cleaned);
  const baseR = path.resolve(base) + path.sep;
  if (full !== path.resolve(base) && !full.startsWith(baseR)) return null;
  return full;
}

trustedHandle('open-write-folder', async (_e, ownerId, name) => {
  const owner = checkedOwner(ownerId);
  if (activeReceiveOwner !== owner) throw new Error('receive was not accepted by this transfer');
  const epoch = receiveEpoch;
  assertReceiveClaim(owner, epoch);
  if (singleReceive || folderReceive) throw new Error('a receive destination is already reserved');
  const downloads = downloadDir();
  const safeName = safeLeafName(name, 'received-folder');
  const session = {
    owner,
    base: null,
    basePromise: null,
    baseCreatedByThisCall: false,
    files: new Map(),
    paths: new Set(),
    openingPromises: new Set(),
    finishPromises: new Set(),
    aborting: false,
  };
  // Reserve before the first mkdir await so a duplicate folder-open cannot
  // create a second directory and replace this session.
  folderReceive = session;
  session.basePromise = (async () => {
    try {
      for (let n = 0; ; n++) {
        const candidate = path.join(downloads, n === 0 ? safeName : `${safeName} (${n})`);
        try {
          await fs.promises.mkdir(candidate);
          session.base = candidate;
          session.baseCreatedByThisCall = true;
          break;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      if (folderReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
        throw new Error('receive was replaced by a newer transfer');
      }
      return session.base;
    } catch (err) {
      const removed = !session.baseCreatedByThisCall || await rmTreeWithRetry(session.base);
      if (folderReceive === session && removed) folderReceive = null;
      if (!removed) throw new Error(`${err.message || err}; partial-folder cleanup failed`);
      throw err;
    }
  })();
  return session.basePromise;
});

trustedHandle('open-write-file', async (_e, ownerId, idx, relPath, size) => {
  const owner = checkedOwner(ownerId);
  const epoch = receiveEpoch;
  const session = folderReceive;
  if (!session || session.owner !== owner || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
    throw new Error('folder belongs to another transfer');
  }
  const checkedIdx = checkedInt(idx, 'file index', 100000);
  const checkedSize = checkedInt(size, 'file size', MAX_TRANSFER_BYTES);
  if (session.files.has(checkedIdx)) throw new Error('file index already open');
  const safeRel = safeRelativePath(relPath);
  const pathKey = safeRel.toLowerCase();
  if (session.paths.has(pathKey)) throw new Error('duplicate folder path');
  const finalPath = safeJoin(session.base, safeRel);
  if (!finalPath) throw new Error('unsafe path rejected: ' + relPath);
  const partPath = finalPath + '.part';
  const file = {
    handle: null, partPath, finalPath, size: checkedSize, relPath: safeRel,
    finishPromise: null, pendingWrites: new Set(), published: false,
    opening: true, createdByThisCall: false, pathKey,
  };
  // Reserve both identities before mkdir/open yield. A duplicate index or a
  // case-insensitive path alias is rejected synchronously and can never clean
  // up another invocation's artifact.
  session.files.set(checkedIdx, file);
  session.paths.add(pathKey);
  const opening = (async () => {
    try {
      await fs.promises.mkdir(path.dirname(finalPath), { recursive: true });
      if (folderReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
        throw new Error('folder receive was replaced');
      }
      file.handle = await fs.promises.open(partPath, 'wx');
      file.createdByThisCall = true;
      if (folderReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
        throw new Error('folder receive was replaced');
      }
      await file.handle.truncate(checkedSize);
      if (folderReceive !== session || session.aborting || !receiveClaimIsCurrent(owner, epoch)) {
        throw new Error('folder receive was replaced');
      }
      file.opening = false;
      return true;
    } catch (err) {
      try { if (file.handle) await file.handle.close(); } catch {}
      file.handle = null;
      file.opening = false;
      const removed = !file.createdByThisCall || await unlinkWithRetry(partPath);
      if (removed && session.files.get(checkedIdx) === file) session.files.delete(checkedIdx);
      if (removed) session.paths.delete(pathKey);
      if (!removed) throw new Error(`${err.message || err}; partial-file cleanup failed`);
      throw err;
    }
  })();
  session.openingPromises.add(opening);
  try { return await opening; }
  finally { session.openingPromises.delete(opening); }
});

trustedHandle('write-file-chunk', async (_e, ownerId, idx, offset, chunk) => {
  const owner = checkedOwner(ownerId);
  const session = folderReceive;
  if (!session || session.owner !== owner || session.aborting) throw new Error('folder belongs to another transfer');
  const f = session.files.get(idx);
  if (!f || f.opening || !f.handle) throw new Error('folder file is not open');
  if (f.finishPromise) throw new Error('folder file is already finalizing');
  checkedInt(offset, 'write offset', f.size);
  const buf = Buffer.from(chunk);
  if (buf.length === 0 || offset + buf.length > f.size) {
    throw new Error('write exceeds declared folder file size');
  }
  const writing = writeAll(f.handle, buf, offset);
  f.pendingWrites.add(writing);
  try { await writing; return true; }
  finally { f.pendingWrites.delete(writing); }
});

trustedHandle('finish-write-file', async (_e, ownerId, idx, expectedHash) => {
  const owner = checkedOwner(ownerId);
  const session = folderReceive;
  if (!session || session.owner !== owner || session.aborting) return { ok: false, path: null, error: 'folder belongs to another transfer' };
  const f = session.files.get(idx);
  if (!f || f.opening || !f.handle) return { ok: false, path: null, error: 'folder file is not open' };
  let expected;
  try { expected = checkedHash(expectedHash); }
  catch (err) { return { ok: false, path: null, error: err.message }; }
  if (f.finishPromise) return f.finishPromise;
  f.finishPromise = (async () => {
    try {
      await Promise.all([...f.pendingWrites]);
      await f.handle.close();
      f.handle = null;
      const stat = await fs.promises.stat(f.partPath);
      if (stat.size !== f.size) throw new Error('received folder file size does not match metadata');
      const got = await hashFile(f.partPath);
      if (got !== expected) return { ok: false, path: null, hash: got, error: 'integrity check failed' };
      await publishPart(f.partPath, f.finalPath);
      f.partPath = null;
      f.published = true;
      session.files.delete(idx);
      return { ok: true, path: f.finalPath, hash: got };
    } catch (err) {
      return { ok: false, path: null, error: err.message || String(err) };
    }
  })();
  session.finishPromises.add(f.finishPromise);
  return f.finishPromise;
});

// Cancel/disconnect during a folder receive: close every open file and delete the
// WHOLE partial folder (v1 promises no partial leftovers).
async function abortFolderReceive(ownerId, force = false) {
  const session = folderReceive;
  if (!session) return true;
  if (!force && session.owner !== ownerId) return true;
  session.aborting = true;
  if (session.basePromise) await session.basePromise.catch(() => {});
  await Promise.allSettled([...session.openingPromises]);
  await Promise.allSettled([...session.finishPromises]);
  for (const f of session.files.values()) {
    if (!f.finishPromise) await Promise.allSettled([...f.pendingWrites]);
    try { if (f.handle) await f.handle.close(); } catch {}
  }
  session.files.clear();
  const removed = !session.baseCreatedByThisCall || await rmTreeWithRetry(session.base);
  if (removed && folderReceive === session) folderReceive = null;
  return removed;
}

trustedHandle('abort-folder', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const removed = await abortFolderReceive(owner, false);
  releaseReceiveOwner(owner);
  return removed;
});

// Once every file has been verified and renamed, stop treating the folder as
// partial. This prevents later window cleanup from deleting a completed receive.
trustedHandle('complete-folder', async (_e, ownerId) => {
  const owner = checkedOwner(ownerId);
  const session = folderReceive;
  if (!session || session.owner !== owner || session.aborting) throw new Error('folder belongs to another transfer');
  await Promise.allSettled([...session.finishPromises]);
  if (session.files.size !== 0) throw new Error('folder still has open files');
  const savedPath = session.base;
  if (folderReceive !== session) throw new Error('folder ownership changed');
  folderReceive = null;
  releaseReceiveOwner(owner);
  return savedPath;
});

function releaseReceiveOwner(owner) {
  if (activeReceiveOwner === owner && !singleReceive && !folderReceive) {
    activeReceiveOwner = null;
    activeReceiveEpoch = 0;
  }
}

async function cleanupTransfers() {
  receiveEpoch += 1;
  activeReceiveOwner = null;
  activeReceiveEpoch = 0;
  await closeReadSource(null, true);
  fileSendOwners.clear();
  folderSendOwners.clear();
  const [singleOk, folderOk] = await Promise.all([
    abortSingleReceive(null, true),
    abortFolderReceive(null, true),
  ]);
  return singleOk && folderOk;
}

trustedHandle('cleanup-transfers', cleanupTransfers);
