/**
 * YShare — mobile (React Native). M1: receive; M2: send — full two-way transfers.
 * Shares the transfer engine with desktop (../shared/engine.js): N parallel
 * connections, range-split file, whole-file SHA-256, deflate-compressed codes.
 * SEND (M2): pick a file (SAF picker -> local copy in cache) -> N offers -> code ->
 * paste reply -> positioned chunk reads (react-native-file-access) -> N channels.
 *
 * RAW-IO FAST PATH (v0.0.3): react-native-webrtc moves every binary message
 * across the RN bridge as NO_WRAP base64 (native<->JS). Instead of decoding/
 * re-encoding those strings in JS, we pass them through untouched:
 *  - receive: tap the lib's native 'dataChannelReceiveMessage' events and hand
 *    the base64 straight to our YRawFile Kotlin module, which decodes natively
 *    and writes at the chunk's absolute offset in the FINAL file — no per-conn
 *    part files, no stitch step, zero JS byte-work.
 *  - send: readFileChunk's base64 goes straight to WebRTCModule.dataChannelSend
 *    (same format), skipping both JS conversions. Falls back to dc.send if the
 *    lib's internals ever change shape.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import RNBlobUtil from 'react-native-blob-util';
import Clipboard from '@react-native-clipboard/clipboard';
import { pick, pickDirectory, keepLocalCopy, isErrorWithCode, errorCodes } from '@react-native-documents/picker';
import { FileSystem } from 'react-native-file-access';
import mobilePackage from './package.json';
import { canPublishToDownloads, directCacheChildDir } from './src/platform-safety';
// Relay config, tuning, code encode/decode (deflate-compressed), base64, and ICE
// helpers come from the SHARED engine — one source of truth for desktop + mobile.
import {
  NUM_CONNS,
  CHUNK,
  PER_CONN_HIGH,
  LOW_THRESHOLD,
  CONNECTION_FAILURE_HELP,
  RTC_CONFIG,
  buildRtcConfig,
  fetchTurnCreds,
  signalDial,
  configureSignaling,
  base64ToU8,
  encodeDescs,
  decodeCode,
  connRange,
  validateOfferFile,
  validateOfferFolder,
  validateFileMeta,
  validateFolderMeta,
  validateDescriptionArray,
  waitIceComplete,
  passwordProof,
  newTransferId,
} from '../shared/engine';

const { WebRTCModule, YRawFile, YForeground } = NativeModules as any;
const foregroundEvents = YForeground ? new NativeEventEmitter(YForeground) : null;

// ---- background transfer notification (CHUNK F) --------------------------
// A foreground service (YForeground/TransferService) keeps the transfer alive
// when the app is backgrounded and shows an ongoing progress notification.
async function ensureNotifPerm() {
  if (Platform.OS === 'android' && Number(Platform.Version) >= 33) {
    try { await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as any); } catch {}
  }
}
async function notifStart(title: string, text: string) {
  try { await YForeground?.start(title, text); }
  catch (e: any) { console.log('YSHARE_FGS start failed ' + (e?.message || e)); }
}
function notifUpdate(title: string, text: string, pct: number) {
  try { YForeground?.update(title, text, Math.max(0, Math.min(100, Math.round(pct)))); } catch {}
}
function notifStop() { try { YForeground?.stop(); } catch {} }

// Split a folder-relative path into a Downloads MediaStore { parentFolder, name }.
// e.g. folder "Trip", relPath "photos/a.jpg" -> { parentFolder: "Trip/photos", name: "a.jpg" }.
function relToMediaStore(folderName: string, relPath: string): { parentFolder: string; name: string } {
  const i = relPath.lastIndexOf('/');
  const sub = i >= 0 ? relPath.slice(0, i) : '';
  const name = i >= 0 ? relPath.slice(i + 1) : relPath;
  return { parentFolder: sub ? `${folderName}/${sub}` : folderName, name };
}

// Same underlying registry react-native-webrtc's own EventEmitter subscribes to;
// constructing it at import time mirrors what the lib itself does.
const nativeTap = new NativeEventEmitter(WebRTCModule);

// Flush pending base64 chunks to the native writer in ~1 MB batches
// (few bridge calls, bounded memory).
const FLUSH = 1024 * 1024;

// Stage 2+3 product flow: the receiver must ACCEPT (with the password if the
// sender set one) before any bytes flow; either side can cancel.
const CONNECT_TIMEOUT_MS = 30000;
const PASSWORD_ATTEMPTS = 3;

// Human-readable byte size (matches desktop fmt).
function fmt(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// Time-remaining label (matches desktop fmtEta): "8s left" / "1m 20s left".
function fmtEta(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  if (m < 60) return `${m}m ${s}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

// Total elapsed label shown when a transfer finishes: "9.2s" / "1m 20s".
function fmtTook(secs: number): string {
  if (!isFinite(secs) || secs < 0) return '—';
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return `${m}m ${s}s`;
}

// Byte length of a NO_WRAP base64 string, without decoding it.
function b64Bytes(s: string): number {
  if (!s || s.length % 4 !== 0 || s.length > Math.ceil(CHUNK / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw new Error('invalid binary chunk');
  }
  let pad = 0;
  if (s.endsWith('==')) pad = 2;
  else if (s.endsWith('=')) pad = 1;
  const n = (s.length / 4) * 3 - pad;
  if (!Number.isSafeInteger(n) || n <= 0 || n > CHUNK) throw new Error('binary chunk is out of range');
  return n;
}

// Wait until a data channel's send buffer drains below the low threshold.
// Uses the bufferedamountlow event when the lib fires it, plus a 100ms poll as a
// belt-and-braces fallback (react-native-webrtc event support varies by version).
function waitDrain(dc: any): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: any = null;
    let settled = false;
    const cleanup = () => {
      try { dc.removeEventListener('bufferedamountlow', done); } catch {}
      try { dc.removeEventListener('close', failed); } catch {}
      try { dc.removeEventListener('error', failed); } catch {}
      if (timer) clearInterval(timer);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const failed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('data channel closed while sending'));
    };
    try { dc.addEventListener('bufferedamountlow', done); } catch {}
    try { dc.addEventListener('close', failed); } catch {}
    try { dc.addEventListener('error', failed); } catch {}
    timer = setInterval(() => {
      if (dc.readyState !== 'open') failed();
      else if (dc.bufferedAmount <= LOW_THRESHOLD) done();
    }, 100);
  });
}

// ---- quick connect server (deliberately NOT compiled into the app) ---------
// YShare runs no server, so this install has to be told which signaling service
// to use for the 6-character code. Manual codes work with it unset. Stored as a
// tiny JSON file next to the app's other private data; validated by the shared
// engine so Android and desktop accept exactly the same addresses.
const SETTINGS_NAME = 'yshare-settings.json';

function settingsPath(): string {
  return `${RNBlobUtil.fs.dirs.DocumentDir}/${SETTINGS_NAME}`;
}

async function readSignalSetting(): Promise<string> {
  try {
    const raw = await RNBlobUtil.fs.readFile(settingsPath(), 'utf8');
    const parsed = JSON.parse(String(raw));
    return typeof parsed?.signalEndpoint === 'string' ? parsed.signalEndpoint : '';
  } catch {
    return '';   // no file yet, unreadable, or corrupt → behave as "not set"
  }
}

async function writeSignalSetting(value: string): Promise<boolean> {
  try {
    await RNBlobUtil.fs.writeFile(settingsPath(), JSON.stringify({ signalEndpoint: value }), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function App(): React.JSX.Element {
  const [engine, setEngine] = useState('checking…');
  // Starts as neither: the first screen is just the logo + the two big choices
  // (owner's call 2026-07-10 — same as desktop).
  const [mode, setMode] = useState<'send' | 'recv' | null>(null);
  const [code, setCode] = useState('');
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('idle');
  const [prog, setProg] = useState('');
  const [barPct, setBarPct] = useState(0);
  // SEND (M2) state
  const [pickedLabel, setPickedLabel] = useState('');
  const [sendCode, setSendCode] = useState('');
  const [replyIn, setReplyIn] = useState('');
  // Stage 2+3 product flow state
  const [sendPass, setSendPass] = useState('');            // sender's optional password
  const [sendActive, setSendActive] = useState(false);     // sending → show Cancel
  const [incoming, setIncoming] = useState<{ tid: string; rawName: string; name: string; size: number; locked: boolean; folder: boolean; count?: number; totalSize?: number } | null>(null);
  const [incMsg, setIncMsg] = useState('');                // password / retry hints
  const [recvPass, setRecvPass] = useState('');            // receiver's password entry
  const [recvActive, setRecvActive] = useState(false);     // receiving → show Cancel
  const [acceptPending, setAcceptPending] = useState(false); // Accept sent; block duplicate/decline taps
  const offerRef = useRef<any>(null);
  const tidRef = useRef('');
  const sendPwRef = useRef('');
  const attemptsRef = useRef(PASSWORD_ATTEMPTS);
  const sendCancelledRef = useRef(false);
  const sendFinishedRef = useRef(false);
  const sendCtrlRef = useRef<any>(null);                   // sender's control channel (f0)
  const sendTimerRef = useRef<any>(null);                  // sender connect timeout
  const sendOpenedRef = useRef(0);                         // sender channels open so far
  const sendPeerReadyRef = useRef(false);                  // receiver said 'ready' on f0
  const offerSentRef = useRef(false);                      // offer-file fired once
  const recvCtrlRef = useRef<any>(null);                   // receiver's control channel (f0)
  const recvCancelledRef = useRef(false);
  const acceptedRef = useRef(false);
  const recvTerminalRef = useRef(false);
  const recvAckSentRef = useRef(false);
  const recvChannelSeenRef = useRef<Set<number>>(new Set());
  const recvChannelIndexRef = useRef<Map<any, number>>(new Map());
  const recvTimerRef = useRef<any>(null);                  // receiver connect timeout
  // quick connect server — empty until the person sets one (nothing is baked in)
  const [signalValue, setSignalValue] = useState('');    // exactly what was typed/stored
  const [srvOpen, setSrvOpen] = useState(false);         // hero: edit box shown
  const [srvMsg, setSrvMsg] = useState('');              // plain-language result line
  const [activeServer, setActiveServer] = useState('');  // the address actually in force
  const signalReadyRef = useRef(false);
  const settingsLoadedRef = useRef(false);
  // quick connect (Stage 1d)
  const [quickCodeOut, setQuickCodeOut] = useState(''); // sender: 6-char code to show
  const [quickIn, setQuickIn] = useState('');           // receiver: 6-char code typed in
  const sigRef = useRef<any>(null);                     // live signaling connection
  // Manual long-code cards stay HIDDEN unless quick connect actually fails
  // (owner decision 2026-07-09): the manual path is insurance, not a feature.
  const [showManual, setShowManual] = useState(false);
  // A transfer reached an end state (done/declined/cancelled/failed) — offer
  // the "↺ New transfer" reset back to the hero screen (owner request 2026-07-11).
  const [flowDone, setFlowDone] = useState(false);
  const pickedRef = useRef<{ path: string; name: string; size: number } | null>(null);
  const sendPcsRef = useRef<any[]>([]);
  const sendDcsRef = useRef<any[]>([]);
  const sentRef = useRef(0);
  const sendStartRef = useRef(0);
  const sendingRef = useRef(false);
  const sendDataCompleteRef = useRef(false);                // all local bytes/messages queued
  const creatingRef = useRef(false);

  const pcsRef = useRef<any[]>([]);
  const totalRef = useRef(0);
  const recvRef = useRef(0);
  const startRef = useRef(0);
  const doneRef = useRef(false);
  const progTimerRef = useRef<any>(null);
  const lastPaintRef = useRef(0);
  // disk-save state (raw-IO fast path)
  const fileNameRef = useRef('received.bin');
  const fileHashRef = useRef('');
  const chansRef = useRef<any[]>([]); // open data channels (to send the final ack)
  const doneConnsRef = useRef(0); // connections whose full range has arrived
  const expectedRef = useRef(0);
  const savingRef = useRef(false);
  // reactTag -> per-connection range state { start, end, cursor, received, pending[], pendingBytes, done }
  const tagStateRef = useRef<Map<any, any>>(new Map());
  const writeChainRef = useRef<Promise<any>>(Promise.resolve()); // serialises open -> writes -> close
  const writeErrRef = useRef<any>(null); // first native write error (chain keeps resolving)
  const fdRef = useRef<number>(0); // YRawFile handle
  const finalPathRef = useRef(''); // app-private final file (hashed, then published)
  const incomingRootRef = useRef(''); // generated app-private root (never peer-derived)
  const preservePrivateRef = useRef(false); // retain verified data if public Downloads publication fails
  const tapSubRef = useRef<any>(null); // native event subscription

  // ===== folder transfer (CHUNK F) =========================================
  // SEND: a picked folder's manifest (files copied into app cache by native copyTreeToCache).
  const pickedFolderRef = useRef<{ name: string; files: { relPath: string; path: string; size: number }[]; totalSize: number; count: number } | null>(null);
  const [isFolder, setIsFolder] = useState(false);           // send: folder vs single file
  // RECEIVE: incoming folder state (mirrors desktop renderer.js CHUNK D).
  const recvFolderRef = useRef<{ name: string; count: number; totalSize: number } | null>(null);
  const folderBaseRef = useRef('');                          // app-private base dir for the incoming tree
  const folderFilesRef = useRef<Map<number, any>>(new Map()); // idx -> { relPath,size,hash,finalPath,fdId,received,done,chain }
  const folderTagRef = useRef<Map<any, any>>(new Map());      // reactTag -> current-file { fileIdx,cursor,expected,received,pending[],pendingBytes,done }
  const folderSentRef = useRef(false);                        // sender's 'folder-sent' arrived
  const filesDoneRef = useRef(0);                             // files finalized (verified or failed)
  const folderErrRef = useRef(false);                         // any file failed hash / write / unsafe path
  const folderMetaSeenRef = useRef<Set<string>>(new Set());
  const folderPathOwnersRef = useRef<Map<string, number>>(new Map());
  const folderDeclaredBytesRef = useRef(0);

  useEffect(() => {
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      pc.close();
      setEngine('✓ loaded');
    } catch (e: any) {
      setEngine('✗ ' + (e?.message || 'failed to load'));
    }
  }, []);

  // Load the stored quick connect server once, and hand it to the shared engine.
  // A release build refuses cleartext to anything but this device (the Android
  // release manifest blocks it too); a debug build may use a LAN test server.
  const applySignal = useCallback((value: string) => {
    const res = configureSignaling(value, { allowInsecure: !!__DEV__ });
    signalReadyRef.current = res.ok && !!res.endpoint;
    // What the hero line shows: the address actually in force, not whatever is
    // half-typed in the box. Showing the typed text would claim a server is in
    // use before it has been saved.
    setActiveServer(res.ok && res.endpoint ? res.endpoint.display : '');
    return res;
  }, []);

  // Reading the stored setting is asynchronous, so a tap during the first moments
  // after launch could otherwise be told "no server" while a perfectly good one is
  // still loading. Both quick paths await this barrier first. Same rule as the
  // desktop's runtimeReady.
  useEffect(() => {
    let alive = true;
    readSignalSetting().then((value) => {
      if (!alive) return;
      setSignalValue(value);
      const res = applySignal(value);
      if (value && !res.ok) setSrvMsg(res.reason);
    }).finally(() => { settingsLoadedRef.current = true; });
    return () => { alive = false; };
  }, [applySignal]);

  function settingsReady(): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => (settingsLoadedRef.current ? resolve() : setTimeout(tick, 25));
      tick();
    });
  }

  async function saveServer() {
    const res = applySignal(signalValue);
    if (!res.ok) { setSrvMsg(res.reason); return; }
    const stored = await writeSignalSetting(signalValue.trim());
    // Usable now either way, but say plainly when it will not survive a restart.
    setSrvMsg(stored
      ? 'saved — quick connect is ready'
      : 'saved for now, but this phone would not let YShare remember it');
  }

  async function removeServer() {
    setSignalValue('');
    applySignal('');
    const stored = await writeSignalSetting('');
    setSrvMsg(stored
      ? 'removed. Manual Connect still works without a Quick Connect server'
      : 'removed for now, but this phone would not let YShare forget it');
  }

  // "↺ New transfer": tear everything down and go back to the hero screen —
  // the next transfer starts from a clean slate.
  async function cleanupSenderCache() {
    const singlePath = pickedRef.current?.path || '';
    const folderRoot = pickedFolderRef.current ? `${RNBlobUtil.fs.dirs.CacheDir}/yshare_send` : '';
    pickedRef.current = null;
    pickedFolderRef.current = null;
    if (singlePath) {
      await RNBlobUtil.fs.unlink(singlePath).catch(() => {});
      // The document picker creates a UUID-like direct child folder around its
      // local cache copy. Remove that now-empty wrapper too, but only when the
      // pure path guard proves it is exactly one level under CacheDir.
      const pickerDir = directCacheChildDir(RNBlobUtil.fs.dirs.CacheDir, singlePath);
      if (pickerDir) await RNBlobUtil.fs.unlink(pickerDir).catch(() => {});
    }
    if (folderRoot) await RNBlobUtil.fs.unlink(folderRoot).catch(() => {});
  }

  async function cleanupReceiveArtifacts(force = false) {
    if (preservePrivateRef.current && !force) return;
    // Capture and detach the exact root before any await. A New Transfer cleanup
    // may overlap the next setup; it must never read a later root from the ref
    // and delete the new transfer's files.
    const root = incomingRootRef.current;
    incomingRootRef.current = '';
    if (force) preservePrivateRef.current = false;
    if (tapSubRef.current) { tapSubRef.current.remove(); tapSubRef.current = null; }
    try {
      if (typeof YRawFile?.abortAll === 'function') await YRawFile.abortAll();
      else {
        if (fdRef.current) await YRawFile?.abortWrite(fdRef.current).catch(() => {});
        for (const fst of folderFilesRef.current.values()) {
          if (fst.fdId) await YRawFile?.abortWrite(fst.fdId).catch(() => {});
        }
      }
    } catch {}
    if (root) await RNBlobUtil.fs.unlink(root).catch(() => {});
  }

  function sendReceiverAckOnce(ok: boolean, reason: string) {
    if (recvAckSentRef.current) return;
    recvAckSentRef.current = true;
    try {
      const ch = recvCtrlRef.current?.readyState === 'open'
        ? recvCtrlRef.current
        : chansRef.current.find((c: any) => c.readyState === 'open');
      ch?.send(JSON.stringify({ type: 'ack', tid: offerRef.current?.tid, ok, reason }));
    } catch {}
  }

  function finishReceive(
    ok: boolean,
    message: string,
    detail: string,
    reason: string,
    preservePrivate = false,
    teardownDelay = 350,
  ) {
    if (recvTerminalRef.current) return false;
    recvTerminalRef.current = true;
    recvCancelledRef.current = !ok;
    savingRef.current = true;
    preservePrivateRef.current = preservePrivate;
    sendReceiverAckOnce(ok, reason);
    setIncoming(null);
    setAcceptPending(false);
    offerRef.current = null;
    setRecvActive(false);
    setFlowDone(true);
    setStatus(message);
    setProg(detail);
    notifStop();
    if (!preservePrivate) cleanupReceiveArtifacts().catch(() => {});
    setTimeout(recvTeardown, teardownDelay);
    return true;
  }

  function failProtocol(reason: unknown) {
    const detail = reason instanceof Error ? reason.message : String(reason || 'invalid transfer data');
    finishReceive(false, 'unsafe or invalid transfer rejected', detail, 'protocol-error');
  }

  function finishSender(message: string, teardownDelay = 250) {
    if (sendFinishedRef.current) return false;
    sendFinishedRef.current = true;
    sendCancelledRef.current = true;
    setSendActive(false);
    setFlowDone(true);
    setStatus(message);
    notifStop();
    cleanupSenderCache().catch(() => {});
    if (teardownDelay >= 0) setTimeout(sendTeardown, teardownDelay);
    return true;
  }

  function resetAll() {
    cleanupSenderCache().catch(() => {});
    // Leaving the terminal result ends the temporary private-copy grace period.
    cleanupReceiveArtifacts(true).catch(() => {});
    sendTeardown();
    recvTeardown();
    notifStop();
    pickedRef.current = null;
    pickedFolderRef.current = null;
    setIsFolder(false);
    offerRef.current = null;
    setMode(null);
    setStatus('idle');
    setProg('');
    setBarPct(0);
    setIncoming(null);
    setIncMsg('');
    setPickedLabel('');
    setSendCode('');
    setReplyIn('');
    setReply('');
    setCode('');
    setQuickIn('');
    setQuickCodeOut('');
    setSendPass('');
    setRecvPass('');
    setShowManual(false);
    setSendActive(false);
    setRecvActive(false);
    setAcceptPending(false);
    setFlowDone(false);
    sendPwRef.current = '';
  }

  useEffect(() => {
    if (!foregroundEvents) return;
    const sub = foregroundEvents.addListener('yshareForegroundTimeout', () => {
      if (sendingRef.current && !sendFinishedRef.current) {
        finishSender('Android stopped the background transfer after its system time limit');
      } else if (acceptedRef.current && !recvTerminalRef.current) {
        finishReceive(
          false,
          'Android stopped the background transfer after its system time limit',
          'Incomplete data was discarded.',
          'background-timeout',
        );
      }
    });
    return () => sub.remove();
    // Functions use live refs; registering once avoids duplicate native listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Android hardware/gesture BACK: from a Send/Receive screen, go back to the hero
  // (same as ← Home) instead of exiting the app; from the hero, exit normally.
  useEffect(() => {
    const onBack = () => {
      if (mode !== null) { resetAll(); return true; }
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Repaint the progress numbers from the byte counter. Called on a timer (~4x/sec),
  // NOT per-chunk — repainting per chunk floods the JS thread and looks choppy.
  function updateProgressUI(final = false) {
    const secs = (Date.now() - startRef.current) / 1000;
    const mb = recvRef.current / 1048576;
    const tot = totalRef.current / 1048576;
    const speed = secs > 0 ? mb / secs : 0;
    const pct = totalRef.current ? (recvRef.current / totalRef.current) * 100 : 0;
    const eta = speed > 0 && recvRef.current < totalRef.current ? fmtEta((tot - mb) / speed) : '';
    setProg(`${mb.toFixed(1)} / ${tot.toFixed(1)} MB · ${pct.toFixed(0)}% · ${speed.toFixed(2)} MB/s${eta ? ' · ' + eta : ''}`);
    setBarPct(Math.min(100, pct));
    notifUpdate('YShare · receiving', `${mb.toFixed(1)}/${tot.toFixed(1)} MB · ${speed.toFixed(1)} MB/s${eta ? ' · ' + eta : ''}`, pct);
    if (final) setStatus(`done ✓ in ${fmtTook(secs)} — avg ${speed.toFixed(2)} MB/s`);
  }

  // Close every receiver-side connection + the signaling socket, reset the cards.
  function recvTeardown() {
    if (recvTimerRef.current) { clearTimeout(recvTimerRef.current); recvTimerRef.current = null; }
    try { sigRef.current?.close(); } catch {}
    sigRef.current = null;
    pcsRef.current.forEach((p) => { try { p.close(); } catch {} });
    pcsRef.current = [];
    recvCtrlRef.current = null;
    setRecvActive(false);
    setAcceptPending(false);
    notifStop();
  }

  // Abort an in-progress receive: stop the native writer, delete the partial
  // final file, optionally tell the sender, and free the connections.
  function abortReceive(notify: boolean, msg: string) {
    if (recvTerminalRef.current) return;
    recvTerminalRef.current = true;
    recvCancelledRef.current = true;
    if (notify) {
      try { recvCtrlRef.current?.send(JSON.stringify({ type: 'cancel', tid: offerRef.current?.tid })); } catch {}
    }
    if (tapSubRef.current) { tapSubRef.current.remove(); tapSubRef.current = null; }
    setIncoming(null);
    setAcceptPending(false);
    offerRef.current = null;
    preservePrivateRef.current = false;
    cleanupReceiveArtifacts().catch(() => {});
    setStatus(msg);
    setProg('');
    setBarPct(0);
    setFlowDone(true);
    notifStop();
    setTimeout(recvTeardown, 300);
  }

  // Channels carry only TEXT control messages through the normal JS event path
  // (offer-file/deny/cancel in, accept/decline/ack out, plus per-channel meta) —
  // binary chunks ride the native tap (onNativeChunk).
  function wireChannel(ch: any, connectionIndex: number) {
    if (recvTerminalRef.current) return;
    if (!Number.isInteger(connectionIndex) || connectionIndex < 0 || connectionIndex >= NUM_CONNS
      || recvChannelSeenRef.current.has(connectionIndex) || ch.label !== `f${connectionIndex}`) {
      failProtocol('unexpected or duplicate data channel');
      return;
    }
    recvChannelSeenRef.current.add(connectionIndex);
    ch.binaryType = 'arraybuffer';
    chansRef.current.push(ch);
    if (connectionIndex === 0) {
      recvCtrlRef.current = ch;   // the control channel
      // Tell the sender our listeners are wired — it holds the file offer until
      // this arrives (see maybeOfferFile). Old senders just ignore it.
      const sayReady = () => { try { ch.send(JSON.stringify({ type: 'ready' })); } catch {} };
      if (ch.readyState === 'open') sayReady();
      else ch.addEventListener('open', sayReady);
    }
    if (ch._reactTag == null) {
      // the native tap matches chunks to channels by reactTag — without it the
      // transfer would stall silently, so fail loud instead
      failProtocol('WebRTC channel identifier is missing');
      return;
    }
    recvChannelIndexRef.current.set(ch._reactTag, connectionIndex);
    ch.addEventListener('message', (ev: any) => {
      if (typeof ev.data !== 'string') return; // binary is handled by the native tap
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'offer-file') {
          if (connectionIndex !== 0 || offerRef.current || acceptedRef.current) {
            throw new Error('unexpected or repeated file offer');
          }
          // Nothing downloads silently: show the incoming card and wait for Accept.
          if (recvTimerRef.current) { clearTimeout(recvTimerRef.current); recvTimerRef.current = null; }
          const off = validateOfferFile(m);
          offerRef.current = off;
          setIncoming(off);
          setRecvPass('');
          setIncMsg(off.locked ? 'This file is locked — enter the password the sender set.' : '');
          setStatus('incoming file — accept to start');
          return;
        }
        if (m.type === 'offer-folder') {
          if (connectionIndex !== 0 || offerRef.current || acceptedRef.current) {
            throw new Error('unexpected or repeated folder offer');
          }
          if (recvTimerRef.current) { clearTimeout(recvTimerRef.current); recvTimerRef.current = null; }
          const off = validateOfferFolder(m);
          recvFolderRef.current = { name: off.name, count: off.count, totalSize: off.totalSize };
          offerRef.current = off;
          setIncoming(off);
          setRecvPass('');
          setIncMsg(off.locked ? 'This folder is locked — enter the password the sender set.' : '');
          setStatus('incoming folder — accept to start');
          return;
        }
        if (m.type === 'file-meta') { onFolderFileMeta(ch, m, connectionIndex); return; }
        if (m.type === 'folder-sent') {
          const off = offerRef.current;
          if (connectionIndex !== 0 || !acceptedRef.current || !off?.folder
            || m.tid !== off.tid || m.count !== off.count || folderSentRef.current) {
            throw new Error('folder completion did not match the accepted offer');
          }
          folderSentRef.current = true;
          if (off.count === 0) {
            startRef.current = Date.now();
            totalRef.current = off.totalSize;
          }
          maybeFinalizeFolder();
          return;
        }
        if (m.type === 'deny') {
          if (connectionIndex !== 0 || !acceptedRef.current || !offerRef.current?.locked
            || m.tid !== offerRef.current.tid
            || !Number.isSafeInteger(m.left) || m.left < 0 || m.left >= PASSWORD_ATTEMPTS) {
            throw new Error('invalid password response');
          }
          acceptedRef.current = false;
          setAcceptPending(false);
          if (m.left > 0) {
            setIncMsg(`Wrong password — ${m.left} attempt${m.left === 1 ? '' : 's'} left.`);
            setStatus('wrong password');
          } else {
            abortReceive(false, 'wrong password 3 times — the sender closed the transfer');
          }
          return;
        }
        if (m.type === 'cancel') {
          if (connectionIndex !== 0 || !offerRef.current || m.tid !== offerRef.current.tid) {
            throw new Error('cancel did not match the accepted transfer');
          }
          abortReceive(false, 'sender cancelled ✗');
          return;
        }
        if (m.type !== 'meta') throw new Error('unknown transfer message');
        const off = offerRef.current;
        if (!acceptedRef.current || !off || off.folder || m.tid !== off.tid) {
          throw new Error('file data arrived before local acceptance');
        }
        if (tagStateRef.current.has(ch._reactTag)) throw new Error('duplicate file metadata');
        const meta = validateFileMeta(m, off, connectionIndex);
        setIncoming(null);
        setRecvActive(true);
        if (!finalPathRef.current) {
          // first meta of the transfer — set up the single final file
          totalRef.current = meta.size;
          fileNameRef.current = meta.name;
          fileHashRef.current = meta.hash;
          startRef.current = Date.now();
          lastPaintRef.current = 0;
          doneRef.current = false;
          setStatus('receiving…');
          notifStart('YShare · receiving', fileNameRef.current).catch(() => {});
          const finalPath = `${incomingRootRef.current}/payload.part`;
          finalPathRef.current = finalPath;
          writeChainRef.current = YRawFile.openWrite(finalPath, meta.size)
            .then((id: number) => { fdRef.current = id; })
            .catch((e: any) => {
              if (!writeErrRef.current) {
                writeErrRef.current = e;
                setStatus('write error: ' + (e?.message || 'failed'));
              }
            });
        } else if (fileHashRef.current !== meta.hash) {
          throw new Error('file hash changed between connections');
        }
        const st = {
          start: meta.start, end: meta.end, cursor: meta.start,
          received: 0, pending: [] as string[], pendingBytes: 0, done: false,
        };
        tagStateRef.current.set(ch._reactTag, st);
        // Zero-byte range (empty file): no chunks will arrive — done straight away.
        if (meta.end - meta.start === 0) {
          st.done = true;
          connDone();
        }
      } catch (e) { failProtocol(e); }
    });
  }

  // Append work to the write chain; the chain always RESOLVES (first error is
  // latched in writeErrRef) so later links and the final close still run in order.
  function queueWrite(fn: () => Promise<any>) {
    writeChainRef.current = writeChainRef.current.then(fn).catch((e: any) => {
      if (!writeErrRef.current) {
        writeErrRef.current = e;
        setStatus('write error: ' + (e?.message || 'failed'));
        console.log('YSHARE_WRITE error ' + (e?.message || e));
      }
    });
  }

  // Hand one connection's pending base64 chunks to the native writer, at the
  // absolute offset of this batch within the file.
  function flushConn(st: any) {
    if (st.pendingBytes === 0) return;
    const parts = st.pending;
    const off = st.cursor;
    st.cursor = off + st.pendingBytes;
    st.pending = [];
    st.pendingBytes = 0;
    queueWrite(() => YRawFile.writeBatch(fdRef.current, off, parts));
  }

  // Native tap: every incoming data-channel message, still in its bridge base64
  // form. Binary chunks are counted + batched here without any JS decode.
  function onNativeChunk(ev: any) {
    if (ev.type !== 'binary' || typeof ev.data !== 'string') return;
    if (recvTerminalRef.current || recvCancelledRef.current) return; // terminal: drop late in-flight chunks
    if (!acceptedRef.current || !offerRef.current) {
      failProtocol('binary data arrived before local acceptance');
      return;
    }
    if (recvFolderRef.current) { onFolderChunk(ev); return; }
    const st = tagStateRef.current.get(ev.reactTag);
    if (!st || st.done) { failProtocol('binary data arrived outside its accepted range'); return; }
    let n = 0;
    try { n = b64Bytes(ev.data); } catch (e) { failProtocol(e); return; }
    const expected = st.end - st.start;
    if (st.received + n > expected || recvRef.current + n > totalRef.current) {
      failProtocol('binary chunk exceeded the accepted file size');
      return;
    }
    st.pending.push(ev.data);
    st.pendingBytes += n;
    st.received += n;
    recvRef.current += n;
    // TRUE network-delivery speed (receiver-side ground truth), logged once when the last byte lands
    if (totalRef.current && recvRef.current >= totalRef.current && !doneRef.current) {
      doneRef.current = true;
      const s = (Date.now() - startRef.current) / 1000;
      console.log(`YSHARE_NETSPEED bytes=${recvRef.current} secs=${s.toFixed(2)} netMBps=${(recvRef.current / 1048576 / s).toFixed(2)}`);
    }
    // inline, throttled repaint (~3x/sec) — rides with data, so it can't freeze on a starved timer
    const now = Date.now();
    if (now - lastPaintRef.current > 300) {
      lastPaintRef.current = now;
      updateProgressUI();
    }
    const complete = st.received === expected;
    if (st.pendingBytes >= FLUSH || complete) flushConn(st);
    if (complete) {
      st.done = true;
      connDone();
    }
  }

  function connDone() {
    doneConnsRef.current += 1;
    if (doneConnsRef.current > expectedRef.current) {
      failProtocol('too many completed byte ranges');
      return;
    }
    if (doneConnsRef.current === expectedRef.current && !savingRef.current) {
      if (recvRef.current !== totalRef.current || tagStateRef.current.size !== expectedRef.current) {
        failProtocol('file ended before every accepted byte arrived');
        return;
      }
      savingRef.current = true;
      if (tapSubRef.current) {
        tapSubRef.current.remove();
        tapSubRef.current = null;
      }
      if (progTimerRef.current) {
        clearInterval(progTimerRef.current);
        progTimerRef.current = null;
      }
      updateProgressUI(false);
      queueWrite(() => YRawFile.closeWrite(fdRef.current));
      writeChainRef.current = writeChainRef.current.then(() => verifyAndPublish());
    }
  }

  // All bytes are already in place in the final file — hash it, compare to the
  // sender's hash, then publish to Downloads. (The old stitch step is gone.)
  async function verifyAndPublish() {
    const tVer = Date.now();
    setRecvActive(false);   // transfer body done — Cancel no longer applies
    setFlowDone(true);      // whatever the verdict, this flow is over
    const finalPath = finalPathRef.current;
    try {
      if (writeErrRef.current) {
        finishReceive(
          false,
          'could not save the incoming file',
          'The incomplete private copy was discarded.',
          'write-error',
        );
        return;
      }
      setStatus('verifying…');
      const got = (await RNBlobUtil.fs.hash(finalPath, 'sha256')).toLowerCase();
      const ok = got === fileHashRef.current;
      if (ok) setBarPct(100);   // transfer complete + intact — fill the lane to the end dot
      const mb = (totalRef.current / 1048576).toFixed(1);
      console.log(`YSHARE_SAVE ok=${ok} verifySecs=${((Date.now() - tVer) / 1000).toFixed(2)} path=${finalPath} got=${got} want=${fileHashRef.current}`);

      if (!ok) {
        setStatus('INTEGRITY MISMATCH ✗');
        setProg(`${mb} MB · hash MISMATCH ✗ — file not saved`);
        finishReceive(
          false,
          'integrity check failed — file discarded',
          `${mb} MB · the received bytes did not match the sender`,
          'integrity-failed',
        );
        return;
      }

      // Verified — publish into the phone's public Downloads via MediaStore (Android 10+, no permission).
      if (!canPublishToDownloads(Platform.OS, Number(Platform.Version))) {
        finishReceive(
          false,
          'verified, but not saved to Downloads',
          'Android 10 or newer is currently required to save received files to Downloads. The verified private copy was kept.',
          'downloads-unsupported',
          true,
        );
        return;
      }
      setStatus('verified ✓ — saving to Downloads…');
      try {
        await RNBlobUtil.MediaCollection.copyToMediaStore(
          { name: fileNameRef.current, parentFolder: '', mimeType: 'application/octet-stream' },
          'Download',
          finalPath,
        );
        await RNBlobUtil.fs.unlink(incomingRootRef.current).catch(() => {}); // drop the app-private copy
        const took = fmtTook((Date.now() - startRef.current) / 1000);
        setStatus('saved to Downloads + verified ✓');
        setProg(`${mb} MB · verified ✓ · took ${took}\nDownloads/${fileNameRef.current}`);
        finishReceive(
          true,
          'saved to Downloads + verified',
          `${mb} MB · verified · took ${took}\nDownloads/${fileNameRef.current}`,
          'saved',
        );
        console.log('YSHARE_SAVE published to Downloads ok');
      } catch (e: any) {
        // Saved + verified, just couldn't publish to Downloads — keep the private copy.
        setStatus('verified ✓ (kept in app storage)');
        setProg(`${mb} MB · verified ✓\n(Downloads copy failed: ${e?.message || 'err'})`);
        finishReceive(
          false,
          'verified, but not saved to Downloads',
          `${mb} MB retained privately · ${e?.message || 'Downloads copy failed'}`,
          'public-save-failed',
          true,
        );
        console.log('YSHARE_SAVE mediastore error ' + (e?.message || e));
      }
    } catch (e: any) {
      setStatus('save error: ' + (e?.message || 'failed'));
      finishReceive(false, 'save failed', e?.message || 'The incomplete file was discarded.', 'save-error');
      console.log('YSHARE_SAVE error ' + (e?.message || e));
    } finally {
      notifStop();   // single-file receive completes without a teardown — stop the notification here
    }
  }

  // ======================= FOLDER RECEIVE (CHUNK F) ========================
  // Mirrors the desktop receiver: each connection streams file `idx`'s range;
  // bytes are written natively at their offset into a per-file preallocated
  // file, each file is SHA-256-verified, then the whole verified tree is
  // published into Downloads/<folder>/… . The private tree is all-or-nothing;
  // MediaStore publication itself is non-transactional and reports partial copies honestly.

  // A per-connection `file-meta` header: (re)point this connection at file `idx`.
  function onFolderFileMeta(ch: any, m: any, connectionIndex: number) {
    const off = offerRef.current;
    if (!acceptedRef.current || !off?.folder || m.tid !== off.tid) {
      throw new Error('folder data arrived before local acceptance');
    }
    const meta = validateFolderMeta(m, off, connectionIndex);
    const pairKey = `${meta.idx}:${connectionIndex}`;
    if (folderMetaSeenRef.current.has(pairKey)) throw new Error('duplicate folder byte range');
    const previous = folderTagRef.current.get(ch._reactTag);
    if (previous && !previous.done) throw new Error('new file metadata arrived before the prior range ended');
    folderMetaSeenRef.current.add(pairKey);

    if (!startRef.current) {
      setIncoming(null);
      setRecvActive(true);
      recvRef.current = 0;
      startRef.current = Date.now();
      lastPaintRef.current = 0;
      totalRef.current = off.totalSize;
      setStatus('receiving…');
      notifStart('YShare · receiving', off.name).catch(() => {});
    }

    let fst = folderFilesRef.current.get(meta.idx);
    if (!fst) {
      const owner = folderPathOwnersRef.current.get(meta.relPath);
      if (owner != null && owner !== meta.idx) throw new Error('two files resolve to the same safe path');
      folderPathOwnersRef.current.set(meta.relPath, meta.idx);
      folderDeclaredBytesRef.current += meta.size;
      if (!Number.isSafeInteger(folderDeclaredBytesRef.current)
        || folderDeclaredBytesRef.current > off.totalSize) throw new Error('folder size exceeded its accepted total');
      const finalPath = `${folderBaseRef.current}/${meta.relPath}`;
      const created: any = {
        relPath: meta.relPath, size: meta.size, hash: meta.hash,
        received: 0, done: false, finalPath, fdId: 0, chain: Promise.resolve(),
      };
      created.chain = YRawFile.openWrite(finalPath, meta.size)
        .then((id: number) => { created.fdId = id; })
        .catch((e: any) => { throw e; });
      folderFilesRef.current.set(meta.idx, created);
      fst = created;
      setStatus(`receiving… file ${folderFilesRef.current.size}/${off.count}`);
    } else if (fst.relPath !== meta.relPath || fst.size !== meta.size || fst.hash !== meta.hash) {
      throw new Error('file metadata changed between folder connections');
    }

    const cs = {
      fileIdx: meta.idx, cursor: meta.start, expected: meta.end - meta.start,
      received: 0, pending: [] as string[], pendingBytes: 0, done: false,
    };
    folderTagRef.current.set(ch._reactTag, cs);
    if (cs.expected === 0) {
      cs.done = true;
      if (fst.received === fst.size) scheduleFinalizeFolderFile(meta.idx);
    }
  }

  // Flush one connection's pending base64 chunks into its current file at the
  // right offset (per-file write chain keeps order + waits for the fd).
  function flushFolderConn(cs: any) {
    if (cs.pendingBytes === 0) return;
    const parts = cs.pending;
    const off = cs.cursor;
    cs.cursor = off + cs.pendingBytes;
    cs.pending = [];
    cs.pendingBytes = 0;
    const fst = folderFilesRef.current.get(cs.fileIdx);
    if (!fst) return;
    fst.chain = fst.chain
      .then(() => YRawFile.writeBatch(fst.fdId, off, parts))
      .catch((e: any) => { folderErrRef.current = true; console.log('YSHARE_FWRITE ' + (e?.message || e)); });
  }

  function onFolderChunk(ev: any) {
    const cs = folderTagRef.current.get(ev.reactTag);
    if (!cs || cs.done) { failProtocol('folder bytes arrived outside an accepted range'); return; }
    let n = 0;
    try { n = b64Bytes(ev.data); } catch (e) { failProtocol(e); return; }
    const fst = folderFilesRef.current.get(cs.fileIdx);
    if (!fst || cs.received + n > cs.expected || fst.received + n > fst.size
      || recvRef.current + n > totalRef.current) {
      failProtocol('folder chunk exceeded its accepted byte range');
      return;
    }
    cs.pending.push(ev.data);
    cs.pendingBytes += n;
    cs.received += n;
    recvRef.current += n;
    fst.received += n;
    const now = Date.now();
    if (now - lastPaintRef.current > 300) { lastPaintRef.current = now; updateProgressUI(); }
    const connComplete = cs.received === cs.expected;
    if (cs.pendingBytes >= FLUSH || connComplete) flushFolderConn(cs);
    if (connComplete) {
      cs.done = true;
      if (fst.received === fst.size) scheduleFinalizeFolderFile(cs.fileIdx);
    }
  }

  // Close + hash one file; when all files + the sender's 'folder-sent' are in, finalize.
  function scheduleFinalizeFolderFile(idx: number) {
    const fst = folderFilesRef.current.get(idx);
    if (!fst || fst.done) return;
    let rangeCount = 0;
    for (let i = 0; i < NUM_CONNS; i++) {
      if (folderMetaSeenRef.current.has(`${idx}:${i}`)) rangeCount += 1;
    }
    if (rangeCount !== NUM_CONNS || fst.received !== fst.size) return;
    fst.done = true;
    fst.chain = fst.chain
      .then(() => YRawFile.closeWrite(fst.fdId))
      .then(() => RNBlobUtil.fs.hash(fst.finalPath, 'sha256'))
      .then((got: string) => { if ((got || '').toLowerCase() !== fst.hash) folderErrRef.current = true; })
      .catch(() => { folderErrRef.current = true; })
      .then(() => { filesDoneRef.current += 1; maybeFinalizeFolder(); });
  }

  async function maybeFinalizeFolder() {
    if (recvCancelledRef.current || savingRef.current) return;
    const fol = recvFolderRef.current;
    if (!fol) return;
    if (!folderSentRef.current || filesDoneRef.current < fol.count) return;   // wait for all files + 'done'
    if (filesDoneRef.current !== fol.count || folderFilesRef.current.size !== fol.count
      || folderDeclaredBytesRef.current !== fol.totalSize
      || recvRef.current !== fol.totalSize
      || folderMetaSeenRef.current.size !== fol.count * NUM_CONNS) {
      failProtocol('folder contents did not match the accepted count and total size');
      return;
    }
    savingRef.current = true;
    if (tapSubRef.current) { tapSubRef.current.remove(); tapSubRef.current = null; }
    setRecvActive(false);
    setFlowDone(true);

    if (folderErrRef.current) {
      finishReceive(
        false,
        'some files failed their integrity check ✗ — folder discarded',
        `${fol.count} file${fol.count === 1 ? '' : 's'} · integrity failed`,
        'folder-integrity-failed',
      );
      return;
    }

    if (fol.count === 0) {                        // empty folder — nothing to publish
      finishReceive(
        false,
        'empty folder could not be saved',
        'The current Android Downloads publisher saves files, so an empty folder has no public item to create.',
        'empty-folder-unsupported',
      );
      return;
    }

    if (!canPublishToDownloads(Platform.OS, Number(Platform.Version))) {
      setBarPct(100);
      finishReceive(
        false,
        'folder verified, but not saved to Downloads',
        'Android 10 or newer is currently required to save received folders to Downloads. The verified private copy was kept.',
        'downloads-unsupported',
        true,
      );
      return;
    }

    // Every file verified — publish the tree into the phone's public Downloads.
    setBarPct(100);
    setStatus('verified ✓ — saving folder to Downloads…');
    let published = 0;
    try {
      for (const fst of folderFilesRef.current.values()) {
        const { parentFolder, name } = relToMediaStore(fol.name, fst.relPath);
        await RNBlobUtil.MediaCollection.copyToMediaStore(
          { name, parentFolder, mimeType: 'application/octet-stream' }, 'Download', fst.finalPath,
        );
        published += 1;
      }
      const took = fmtTook((Date.now() - startRef.current) / 1000);
      finishReceive(
        true,
        'folder saved to Downloads + verified',
        `${fol.count} file${fol.count === 1 ? '' : 's'} · verified · took ${took}\nDownloads/${fol.name}/`,
        'saved',
      );
    } catch (e: any) {
      finishReceive(
        false,
        'folder verified, but not fully saved to Downloads',
        `${published}/${fol.count} copied to Downloads · verified private copy kept · ${e?.message || 'copy failed'}`,
        'public-save-failed',
        true,
      );
    }
  }

  // ======================= SEND (M2) =======================================

  // Total bytes to send (folder total, or single-file size).
  function sendTotal(): number {
    return pickedFolderRef.current ? pickedFolderRef.current.totalSize : (pickedRef.current?.size ?? 0);
  }

  function paintSendProgress(final = false) {
    if (!pickedRef.current && !pickedFolderRef.current) return;
    const total = sendTotal();
    const secs = (Date.now() - sendStartRef.current) / 1000;
    const mb = sentRef.current / 1048576;
    const tot = total / 1048576;
    const speed = secs > 0 ? mb / secs : 0;
    const pct = total ? (sentRef.current / total) * 100 : 0;
    const eta = speed > 0 && sentRef.current < total ? fmtEta((tot - mb) / speed) : '';
    setProg(`${mb.toFixed(1)} / ${tot.toFixed(1)} MB · ${pct.toFixed(0)}% · ${speed.toFixed(2)} MB/s${eta ? ' · ' + eta : ''}`);
    setBarPct(Math.min(100, pct));
    notifUpdate('YShare · sending', `${mb.toFixed(1)}/${tot.toFixed(1)} MB · ${speed.toFixed(1)} MB/s${eta ? ' · ' + eta : ''}`, pct);
    if (final) setStatus(`sent in ${fmtTook(secs)} — avg ${speed.toFixed(2)} MB/s — waiting for receiver to verify…`);
  }

  // Pick a file via the system picker, then copy it into app cache so we can do
  // positioned chunk reads on a real file path (SAF content:// URIs don't seek).
  async function pickFile() {
    try {
      const [res] = await pick();
      const name = res.name || 'file.bin';
      setStatus('copying the file into app storage…');
      const [copy] = await keepLocalCopy({
        files: [{ uri: res.uri, fileName: name }],
        destination: 'cachesDirectory',
      });
      if (copy.status !== 'success') throw new Error('could not copy the picked file');
      const path = copy.localUri.replace('file://', '');
      const size = res.size ?? (await RNBlobUtil.fs.stat(path)).size;
      pickedRef.current = { path, name, size };
      pickedFolderRef.current = null;   // file OR folder, never both
      setIsFolder(false);
      setPickedLabel(`${name} · ${(size / 1048576).toFixed(1)} MB`);
      setStatus('file ready — create your code');
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return;
      setStatus('pick error: ' + (e?.message || 'failed'));
    }
  }

  // Pick a whole FOLDER (SAF tree), then have native copyTreeToCache materialise
  // it into app cache as real seekable files so the existing chunk-reader can
  // stream each file. Builds the folder manifest the sender streams (CHUNK F).
  async function pickFolder() {
    try {
      const dir: any = await pickDirectory();
      if (!dir || !dir.uri) return;
      setStatus('reading the folder…');
      const manifest: any = await YRawFile.copyTreeToCache(dir.uri);
      const files: { relPath: string; path: string; size: number }[] = (manifest.files || [])
        .map((f: any) => ({ relPath: f.relPath, path: f.path, size: Number(f.size) || 0 }));
      const totalSize = files.reduce((a, f) => a + f.size, 0);
      pickedFolderRef.current = { name: manifest.name || 'folder', files, totalSize, count: files.length };
      pickedRef.current = null;   // file OR folder, never both
      setIsFolder(true);
      setPickedLabel(`${manifest.name} · ${files.length} file${files.length === 1 ? '' : 's'} · ${fmt(totalSize)}`);
      setStatus(files.length ? 'folder ready — get your code' : 'that folder is empty — nothing to send');
    } catch (e: any) {
      if (isErrorWithCode(e) && e.code === errorCodes.OPERATION_CANCELED) return;
      setStatus('folder pick error: ' + (e?.message || 'failed'));
    }
  }

  // Close every sender-side connection + the signaling socket. keepSignal=true
  // is for the start of a NEW handshake: sigRef already holds the LIVE socket
  // carrying it — closing it here silently killed the room and the offers never
  // left the phone (found on-device 2026-07-10; desktop tracks the previous
  // socket separately so only mobile had this).
  function sendTeardown(keepSignal?: boolean) {
    if (sendTimerRef.current) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
    if (!keepSignal) { try { sigRef.current?.close(); } catch {} }
    sendPcsRef.current.forEach((p) => { try { p.close(); } catch {} });
    sendPcsRef.current = [];
    sendDcsRef.current = [];
    sendCtrlRef.current = null;
    setSendActive(false);
    notifStop();
  }

  // Offer only when BOTH our channels are open AND the receiver said 'ready'.
  // Offering on open alone can lose the offer: react-native-webrtc drops
  // messages that arrive before the receiver's JS listener attaches (seen
  // on-device 2026-07-10) — the receiver's 'ready' proves its listeners exist.
  function maybeOfferFile() {
    if (offerSentRef.current) return;
    if (sendOpenedRef.current === NUM_CONNS && sendPeerReadyRef.current) {
      offerSentRef.current = true;
      offerFile();
    }
  }

  // All channels open → offer the file (or folder); nothing is sent until accept.
  function offerFile() {
    setStatus('connected — waiting for the receiver to accept…');
    const fol = pickedFolderRef.current;
    try {
      const control = sendCtrlRef.current;
      if (!control || control.readyState !== 'open') throw new Error('control channel is not open');
      if (fol) {
        control.send(JSON.stringify({
          type: 'offer-folder', tid: tidRef.current, name: fol.name,
          count: fol.count, totalSize: fol.totalSize, locked: !!sendPwRef.current,
        }));
      } else if (pickedRef.current) {
        const f = pickedRef.current;
        control.send(JSON.stringify({
          type: 'offer-file', tid: tidRef.current, name: f.name, size: f.size,
          locked: !!sendPwRef.current,
        }));
      }
    } catch {
      finishSender('could not send the transfer offer');
    }
  }

  // Build the N sender connections + offers with the given RTC config; returns
  // the encoded offers code. Shared by the manual and quick flows.
  async function buildSendOffers(rtcConfig: any): Promise<string> {
    sendTeardown(true);   // fresh start — but the live handshake socket stays open
    sendingRef.current = false;
    sendDataCompleteRef.current = false;
    sentRef.current = 0;
    sendCancelledRef.current = false;
    sendFinishedRef.current = false;
    attemptsRef.current = PASSWORD_ATTEMPTS;
    tidRef.current = newTransferId();
    sendPwRef.current = sendPass.trim();
    sendOpenedRef.current = 0;
    sendPeerReadyRef.current = false;
    offerSentRef.current = false;

    const pcs: any[] = [];
    const dcs: any[] = [];
    for (let i = 0; i < NUM_CONNS; i++) {
      // typed as any: react-native-webrtc's .d.ts omits addEventListener (runtime has it)
      const pc: any = new RTCPeerConnection(rtcConfig);
      const dc: any = pc.createDataChannel('f' + i, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_THRESHOLD;
      dc.addEventListener('message', (event: any) => onSenderMsg(event, i));
      dc.addEventListener('open', () => {
        sendOpenedRef.current += 1;
        maybeOfferFile();
      });
      if (i === 0) {
        sendCtrlRef.current = dc;
        pc.addEventListener('connectionstatechange', () => {
          const s = pc.connectionState;
          if (s === 'connected') {
            if (sendTimerRef.current) { clearTimeout(sendTimerRef.current); sendTimerRef.current = null; }
          } else if ((s === 'failed' || s === 'disconnected')
            && !sendFinishedRef.current && !sendCancelledRef.current) {
            finishSender(sendingRef.current
              ? 'connection lost mid-transfer ✗ — ask the receiver to reconnect'
              : 'connection lost before the receiver accepted ✗', 0);
          }
        });
      }
      pcs.push(pc);
      dcs.push(dc);
    }
    await Promise.all(pcs.map(async (pc) => {
      const offer = await pc.createOffer({});
      await pc.setLocalDescription(offer);
      await waitIceComplete(pc);
    }));
    sendPcsRef.current = pcs;
    sendDcsRef.current = dcs;
    return encodeDescs(pcs.map((pc) => pc.localDescription));
  }

  // Apply the receiver's answers to the sender connections (both flows).
  async function applySendAnswers(answers: any[]) {
    const checkedAnswers = validateDescriptionArray(answers, 'answer');
    if (checkedAnswers.length !== sendPcsRef.current.length) {
      throw new Error('reply does not match this code');
    }
    setStatus('connecting…');
    await Promise.all(sendPcsRef.current.map((pc, i) =>
      pc.setRemoteDescription(new RTCSessionDescription(checkedAnswers[i])),
    ));
    // If ICE never lands, don't hang forever.
    sendTimerRef.current = setTimeout(() => {
      if (!sendingRef.current && !sendFinishedRef.current) {
        finishSender(CONNECTION_FAILURE_HELP, 0);
      }
    }, CONNECT_TIMEOUT_MS);
  }

  // Manual flow: long code shown for copy-paste. Relay creds fetched over HTTP
  // when our box is reachable; otherwise direct-only (still free, still works).
  async function createSendCode() {
    if ((!pickedRef.current && !pickedFolderRef.current) || creatingRef.current) return;
    creatingRef.current = true;
    try {
      setStatus('creating code…');
      setSendCode('');
      const turn = await fetchTurnCreds();
      const c = await buildSendOffers(buildRtcConfig(turn));
      setSendCode(c);
      setStatus('code ready — send it to the receiver' + (turn ? '' : ' (direct-only)'));
    } catch (e: any) {
      setStatus('error: ' + (e?.message || 'failed'));
    } finally {
      creatingRef.current = false;
    }
  }

  async function connectAndSend() {
    try {
      await applySendAnswers(decodeCode(replyIn));
    } catch (e: any) {
      setStatus('bad reply code: ' + (e?.message || ''));
    }
  }

  // Quick flow (sender): 6-char room code from the signaling server; the long
  // codes ride the server automatically — nothing to copy.
  async function getQuickCode() {
    if ((!pickedRef.current && !pickedFolderRef.current) || creatingRef.current) return;
    // Nothing is compiled in: without a server there is no room to open.
    await settingsReady();
    if (!signalReadyRef.current) {
      setShowManual(true);
      setStatus('quick connect needs a server — set one on the home screen, or use the manual code');
      return;
    }
    creatingRef.current = true;
    let quickTurn: any = null;
    let gotAnswers = false;
    try {
      setStatus('contacting connect server…');
      setQuickCodeOut('');
      try { sigRef.current?.close(); } catch {}
      const sig = await signalDial();
      sigRef.current = sig;
      // The room dies with this socket (server sweep / network blip) — without
      // this the app kept showing a dead code forever (seen 2026-07-10).
      sig.onClose = () => {
        if (gotAnswers) return;   // normal teardown — handshake already delivered
        setQuickCodeOut('');
        setStatus('lost the connection to the code server — get a new quick code');
      };
      sig.onMessage = async (m: any) => {
        try {
          if (m.t === 'created') {
            quickTurn = m.turn;
            setQuickCodeOut(m.code);
            setStatus(`quick code ${m.code} — tell it to the receiver`);
          } else if (m.t === 'peer') {
            setStatus('receiver joined — connecting…');
            const c = await buildSendOffers(buildRtcConfig(quickTurn));
            sig.send({ t: 'msg', data: { kind: 'offers', code: c } });
          } else if (m.t === 'msg' && m.data && m.data.kind === 'answers') {
            gotAnswers = true;
            await applySendAnswers(decodeCode(m.data.code));
            sig.send({ t: 'done' });
            sig.close();
          } else if (m.t === 'err') {
            setStatus('connect server: ' + m.why);
          }
        } catch {
          setStatus('quick connect failed — manual codes unlocked below');
          setShowManual(true);
        }
      };
      sig.send({ t: 'create' });
    } catch {
      setStatus('quick connect unavailable — manual codes unlocked below');
      setShowManual(true);
    } finally {
      creatingRef.current = false;
    }
  }

  function onSenderMsg(ev: any, connectionIndex: number) {
    if (typeof ev.data !== 'string') return;
    try {
      const m = JSON.parse(ev.data);
      if (connectionIndex !== 0) {
        finishSender('receiver sent control data on an invalid channel');
        return;
      }
      if (m.type === 'ready') {
        sendPeerReadyRef.current = true;
        maybeOfferFile();
      } else if (m.type === 'accept') {
        if (sendingRef.current || sendFinishedRef.current) return;
        if (!offerSentRef.current || m.tid !== tidRef.current) {
          finishSender('receiver response did not match this transfer');
          return;
        }
        if (sendPwRef.current) {
          // proof = sha256(tid + ':' + password) — the password itself never travels
          if (m.auth !== passwordProof(tidRef.current, sendPwRef.current)) {
            attemptsRef.current -= 1;
            try {
              sendCtrlRef.current?.send(JSON.stringify({ type: 'deny', tid: tidRef.current, left: attemptsRef.current }));
            } catch {}
            if (attemptsRef.current <= 0) {
              // Lock terminal state immediately so a fourth, correct Accept cannot
              // start while the final denial is draining to the receiver.
              finishSender('receiver failed the password 3 times — stopped', 400);
            } else {
              setStatus(`wrong password from receiver (${attemptsRef.current} attempt${attemptsRef.current === 1 ? '' : 's'} left)`);
            }
            return;
          }
        }
        startSending();
      } else if (m.type === 'decline') {
        if (!offerSentRef.current || m.tid !== tidRef.current) {
          finishSender('receiver response did not match this transfer');
          return;
        }
        finishSender('receiver declined the file', 200);
      } else if (m.type === 'cancel') {
        if (!offerSentRef.current || m.tid !== tidRef.current) {
          finishSender('receiver response did not match this transfer');
          return;
        }
        finishSender('receiver cancelled ✗', 200);
      } else if (m.type === 'ack') {
        if (!sendingRef.current || !sendDataCompleteRef.current
          || m.tid !== tidRef.current || typeof m.ok !== 'boolean') {
          finishSender('receiver sent an invalid completion response');
          return;
        }
        paintSendProgress();
        if (m.ok) setBarPct(100);   // receiver confirmed intact — fill the lane to the end dot
        finishSender(m.ok
          ? 'receiver verified the file ✓ — transfer complete'
          : 'receiver could not complete the save ✗', 0);
      }
    } catch {
      finishSender('receiver sent invalid control data');
    }
  }

  // Sender-side Cancel: also an end state — offer the fresh-start button after.
  // Mid-transfer the control channel holds buffered
  // file bytes AHEAD of the queued 'cancel' — tearing down on a fixed grace
  // period lost the message (receiver showed "connection lost" instead of
  // "sender cancelled", seen on-device 2026-07-10). Wait for the drain, capped.
  function cancelSend() {
    if (sendFinishedRef.current) return;
    const dc = sendCtrlRef.current;
    try { dc?.send(JSON.stringify({ type: 'cancel', tid: tidRef.current })); } catch {}
    finishSender('cancelled', -1);
    const t0 = Date.now();
    const drain = () => {
      if (dc && dc.readyState === 'open' && dc.bufferedAmount > 0 && Date.now() - t0 < 3000) {
        setTimeout(drain, 50);
      } else {
        setTimeout(sendTeardown, 200);   // let the final frame hit the wire
      }
    };
    drain();
  }

  // Folder send: stream files ONE AT A TIME, each split across the N connections
  // (reuses sendRange — each cache file is a real seekable path). A per-connection
  // `file-meta` header precedes each file's range bytes. Mirrors desktop CHUNK D.
  async function startSendingFolder() {
    const fol = pickedFolderRef.current;
    if (!fol) return;
    setStatus(`preparing folder “${fol.name}”…`);
    setSendActive(true);
    sentRef.current = 0;
    sendStartRef.current = Date.now();
    lastPaintRef.current = 0;
    try {
      for (let i = 0; i < fol.files.length; i++) {
        if (sendCancelledRef.current) return;
        const file = fol.files[i];
        const hash = (await RNBlobUtil.fs.hash(file.path, 'sha256')).toLowerCase();
        if (sendCancelledRef.current) return;
        setStatus(`sending… file ${i + 1}/${fol.files.length}`);
        await Promise.all(sendDcsRef.current.map((dc, k) => {
          const { start, end } = connRange(k, file.size, NUM_CONNS);
          dc.send(JSON.stringify({
            type: 'file-meta', tid: tidRef.current, idx: i, relPath: file.relPath,
            size: file.size, hash, start, end, count: fol.files.length,
          }));
          return sendRange(dc, file.path, start, end);
        }));
      }
      if (!sendCancelledRef.current) {
        const control = sendCtrlRef.current;
        if (!control || control.readyState !== 'open') throw new Error('control channel closed before folder completion');
        control.send(JSON.stringify({ type: 'folder-sent', tid: tidRef.current, count: fol.files.length }));
        sendDataCompleteRef.current = true;
        paintSendProgress(true);
      }
    } catch (e: any) {
      if (!sendCancelledRef.current && !sendFinishedRef.current) {
        try { sendCtrlRef.current?.send(JSON.stringify({ type: 'cancel', tid: tidRef.current })); } catch {}
        finishSender('send failed ✗ — ' + (e?.message || 'could not read the folder'), 300);
      }
    }
  }

  async function startSending() {
    if (sendingRef.current) return;
    if (!pickedRef.current && !pickedFolderRef.current) return;
    sendingRef.current = true;
    await ensureNotifPerm();
    notifStart('YShare · sending', pickedFolderRef.current?.name || pickedRef.current?.name || 'file').catch(() => {});
    if (pickedFolderRef.current) { await startSendingFolder(); return; }
    const f = pickedRef.current!;
    setStatus('preparing (hashing the file)…');
    try {
      const hash = (await RNBlobUtil.fs.hash(f.path, 'sha256')).toLowerCase();
      setStatus('sending…');
      setSendActive(true);
      sentRef.current = 0;
      sendStartRef.current = Date.now();
      lastPaintRef.current = 0;
      await Promise.all(sendDcsRef.current.map((dc, i) => {
        const { start, end } = connRange(i, f.size, NUM_CONNS);
        dc.send(JSON.stringify({ type: 'meta', tid: tidRef.current, name: f.name, size: f.size, hash, start, end }));
        return sendRange(dc, f.path, start, end);
      }));
      if (!sendCancelledRef.current) {
        sendDataCompleteRef.current = true;
        paintSendProgress(true);
      }
    } catch (e: any) {
      // source file unreadable mid-send, or a channel died under us
      if (!sendCancelledRef.current && !sendFinishedRef.current) {
        try { sendCtrlRef.current?.send(JSON.stringify({ type: 'cancel', tid: tidRef.current })); } catch {}
        finishSender('send failed ✗ — ' + (e?.message || 'could not read the file'), 300);
      }
    }
  }

  // Stream one byte range over one channel: positioned chunk reads + backpressure.
  // FAST PATH: readFileChunk returns NO_WRAP base64, and WebRTCModule.dataChannelSend
  // natively decodes that exact format — so the string passes straight through with
  // ZERO JS byte-work (no base64->bytes here, no bytes->base64 inside dc.send).
  // Falls back to the normal dc.send if the lib's internals ever change shape.
  async function sendRange(dc: any, path: string, start: number, end: number) {
    const fast = WebRTCModule && typeof WebRTCModule.dataChannelSend === 'function'
      && typeof dc._peerConnectionId === 'number' && dc._reactTag != null;
    let offset = start;
    while (offset < end) {
      if (sendCancelledRef.current) return;
      if (dc.bufferedAmount > PER_CONN_HIGH) await waitDrain(dc);
      if (sendCancelledRef.current) return;
      const len = Math.min(CHUNK, end - offset);
      const b64 = await FileSystem.readFileChunk(path, offset, len, 'base64');
      if (fast) {
        WebRTCModule.dataChannelSend(dc._peerConnectionId, dc._reactTag, b64, 'binary');
      } else {
        dc.send(base64ToU8(b64));
      }
      offset += len;
      sentRef.current += len;
      const now = Date.now();
      if (now - lastPaintRef.current > 300) {
        lastPaintRef.current = now;
        paintSendProgress();
      }
    }
  }

  // ======================= RECEIVE (M1) =====================================

  // Accept the offered file (with the password proof when locked).
  function acceptIncoming() {
    const off = offerRef.current;
    if (!off || recvTerminalRef.current || acceptedRef.current || acceptPending) return;
    const msg: any = { type: 'accept', tid: off.tid };
    if (off.locked) {
      if (!recvPass.trim()) { setIncMsg('Enter the password first.'); return; }
      msg.auth = passwordProof(off.tid, recvPass.trim());
      setIncMsg('Checking password…');
    } else {
      setIncMsg('Accepted — waiting for the sender…');
    }
    acceptedRef.current = true;
    setAcceptPending(true);
    ensureNotifPerm().catch(() => {});   // permission prompt is tied to the local Accept gesture
    try {
      const control = recvCtrlRef.current;
      if (!control || control.readyState !== 'open') throw new Error('control channel is not open');
      control.send(JSON.stringify(msg));
    } catch {
      acceptedRef.current = false;
      setAcceptPending(false);
      setStatus('could not send acceptance — reconnect and try again');
    }
  }

  function declineIncoming() {
    if (recvTerminalRef.current || acceptedRef.current || acceptPending) return;
    const tid = offerRef.current?.tid;
    try { recvCtrlRef.current?.send(JSON.stringify({ type: 'decline', tid })); } catch {}
    abortReceive(false, 'declined');
  }

  // Receiver-side Cancel button (mid-transfer).
  function cancelReceive() {
    abortReceive(true, 'cancelled — the incomplete file was discarded');
  }

  function copyReply() {
    if (!reply) return;
    Clipboard.setString(reply);
    setStatus('reply copied ✓ — paste it back to your PC');
  }

  // Answer a decoded offers array with the given RTC config; resets all receive
  // state and returns the encoded reply. Shared by the manual and quick flows.
  async function answerOffers(offers: any[], rtcConfig: any): Promise<string> {
    // The raw-IO fast path needs the Kotlin module baked into the APK. If the
    // JS is newer than the installed binary, fail loud instead of half-working.
    if (!YRawFile || !WebRTCModule) {
      throw new Error('app rebuild needed — native write module missing');
    }
    const checkedOffers = validateDescriptionArray(offers, 'offer');
    // A preserved verified copy belongs only to the previous result screen.
    // Delete it fully before assigning this transfer a new private root.
    await cleanupReceiveArtifacts(true);
    setProg('');
    setBarPct(0);
    setIncoming(null);
    setIncMsg('');
    offerRef.current = null;
    recvCtrlRef.current = null;
    recvCancelledRef.current = false;
    acceptedRef.current = false;
    setAcceptPending(false);
    recvTerminalRef.current = false;
    recvAckSentRef.current = false;
    recvChannelSeenRef.current = new Set();
    recvChannelIndexRef.current = new Map();
    preservePrivateRef.current = false;
    setRecvActive(false);
    if (recvTimerRef.current) { clearTimeout(recvTimerRef.current); recvTimerRef.current = null; }
    recvRef.current = 0;
    totalRef.current = 0;
    startRef.current = 0;
    doneRef.current = false;
    chansRef.current = [];
    doneConnsRef.current = 0;
    savingRef.current = false;
    tagStateRef.current = new Map();
    writeChainRef.current = Promise.resolve();
    writeErrRef.current = null;
    fdRef.current = 0;
    finalPathRef.current = '';
    // folder-receive state (CHUNK F) — clear any stale partial tree up front so
    // openWrite's per-file creation can't race an async cleanup mid-transfer.
    recvFolderRef.current = null;
    incomingRootRef.current = `${RNBlobUtil.fs.dirs.DocumentDir}/yshare_incoming/${newTransferId()}`;
    folderBaseRef.current = `${incomingRootRef.current}/folder`;
    folderFilesRef.current = new Map();
    folderTagRef.current = new Map();
    folderSentRef.current = false;
    filesDoneRef.current = 0;
    folderErrRef.current = false;
    folderMetaSeenRef.current = new Set();
    folderPathOwnersRef.current = new Map();
    folderDeclaredBytesRef.current = 0;
    await RNBlobUtil.fs.unlink(folderBaseRef.current).catch(() => {});
    if (tapSubRef.current) {
      tapSubRef.current.remove();
      tapSubRef.current = null;
    }
    if (progTimerRef.current) {
      clearInterval(progTimerRef.current);
      progTimerRef.current = null;
    }
    expectedRef.current = checkedOffers.length;

    // Tap the lib's native receive events — binary chunks are grabbed here in
    // their bridge base64 form and written natively (see onNativeChunk).
    tapSubRef.current = nativeTap.addListener('dataChannelReceiveMessage', onNativeChunk);

    pcsRef.current.forEach((p) => {
      try { p.close(); } catch {}
    });
    pcsRef.current = [];

    const answers: any[] = [];
    for (let i = 0; i < checkedOffers.length; i++) {
      // typed as any: react-native-webrtc's .d.ts omits addEventListener (runtime has it)
      const pc: any = new RTCPeerConnection(rtcConfig);
      pc.addEventListener('datachannel', (e: any) => wireChannel(e.channel, i));
      if (i === 0) {
        // the first connection stands in for all of them (they connect together)
        pc.addEventListener('connectionstatechange', () => {
          const s = pc.connectionState;
          if (s === 'connected') {
            if (recvTimerRef.current) { clearTimeout(recvTimerRef.current); recvTimerRef.current = null; }
          } else if ((s === 'failed' || s === 'disconnected') && acceptedRef.current && !savingRef.current) {
            abortReceive(false, 'connection lost — transfer interrupted ✗');
          } else if (s === 'failed' && !acceptedRef.current && !savingRef.current) {
            setStatus(CONNECTION_FAILURE_HELP);
          }
        });
      }
      await pc.setRemoteDescription(new RTCSessionDescription(checkedOffers[i]));
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await waitIceComplete(pc);
      pcsRef.current.push(pc);
      answers.push(pc.localDescription);
    }
    // If the sender never shows up (or ICE stalls), don't hang forever.
    recvTimerRef.current = setTimeout(() => {
      if (!offerRef.current && !acceptedRef.current && !savingRef.current) {
        setStatus(CONNECTION_FAILURE_HELP);
        recvTeardown();
      }
    }, CONNECT_TIMEOUT_MS);
    return encodeDescs(answers);
  }

  // Manual flow: paste the long code, produce a long reply to send back.
  async function createReply(codeArg?: any) {
    try {
      const raw = typeof codeArg === 'string' ? codeArg : code;
      setStatus('creating reply…');
      setReply('');
      const offers = decodeCode(raw);
      const turn = await fetchTurnCreds();
      const r = await answerOffers(offers, buildRtcConfig(turn));
      setReply(r);
      setStatus(`reply ready (${offers.length} conns) — send it back to your PC`);
      return r;
    } catch (e: any) {
      setStatus('error: ' + (e?.message || 'failed'));
    }
  }

  // Quick flow (receiver): type the sender's 6-char code — everything else is
  // automatic (the long codes ride the signaling server).
  async function joinQuick() {
    const c = quickIn.trim().toUpperCase();
    if (c.length !== 6) {
      setStatus('enter the 6-character code');
      return;
    }
    await settingsReady();
    if (!signalReadyRef.current) {
      setShowManual(true);
      setStatus('quick connect needs a server — set one on the home screen, or use the manual code');
      return;
    }
    let quickTurn: any = null;
    let gotOffers = false;
    try {
      setStatus('contacting connect server…');
      try { sigRef.current?.close(); } catch {}
      const sig = await signalDial();
      sigRef.current = sig;
      sig.onClose = () => {
        if (gotOffers) return;   // normal teardown — handshake already delivered
        setStatus('lost the connection to the code server — try the code again');
      };
      sig.onMessage = async (m: any) => {
        try {
          if (m.t === 'joined') {
            quickTurn = m.turn;
            setStatus('found the sender — waiting for connection details…');
          } else if (m.t === 'msg' && m.data && m.data.kind === 'offers') {
            gotOffers = true;
            const replyCode = await answerOffers(decodeCode(m.data.code), buildRtcConfig(quickTurn));
            sig.send({ t: 'msg', data: { kind: 'answers', code: replyCode } });
            setStatus('connecting…');
          } else if (m.t === 'gone') {
            sig.close(); // handshake delivered (or room died) — socket's job is over
          } else if (m.t === 'err') {
            setStatus('connect server: ' + m.why);
          }
        } catch (e: any) {
          setStatus('quick connect failed: ' + (e?.message || 'manual codes unlocked below'));
          setShowManual(true);
        }
      };
      sig.send({ t: 'join', code: c });
    } catch {
      setStatus('quick connect unavailable — manual codes unlocked below');
      setShowManual(true);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={C.paper} />
      <ScrollView contentContainerStyle={[styles.content, mode === null && styles.landing]}>
        {mode === null ? (
          /* HERO landing — two big Send / Receive cards (COURIER) */
          <>
            <Text style={styles.heroKicker}>PEER-TO-PEER FILE SHARING</Text>
            <Text style={styles.heroLogo}>
              <Text style={styles.y}>Y</Text><Text style={styles.share}>Share</Text>
            </Text>
            <View style={styles.heroRule} />
            <Text style={styles.heroSub}>SEND ANYTHING TO ANYONE</Text>
            <View style={styles.heroModes}>
              <TouchableOpacity style={styles.heroCard} activeOpacity={0.85} onPress={() => setMode('send')}>
                <View style={styles.heroCardHead}>
                  <Text style={styles.roleLabel}>FOR THE SENDER</Text>
                  <View style={styles.badgeSend}><Text style={styles.badgeSendY}>Y</Text></View>
                </View>
                <Text style={styles.heroTitle}>Send</Text>
                <Text style={styles.heroCopy}>Choose a file and we hand you a short code — pass it along like a claim ticket.</Text>
                <Text style={styles.heroLink}>DISPATCH →</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.heroCard} activeOpacity={0.85} onPress={() => setMode('recv')}>
                <View style={styles.heroCardHead}>
                  <Text style={styles.roleLabel}>FOR THE RECEIVER</Text>
                  <View style={styles.badgeRecv}><Text style={styles.badgeRecvArrow}>↓</Text></View>
                </View>
                <Text style={styles.heroTitle}>Receive</Text>
                <Text style={styles.heroCopy}>Type the sender's 6-character code and the file comes straight to you.</Text>
                <Text style={styles.heroLink}>COLLECT →</Text>
              </TouchableOpacity>
            </View>

            {/* Quick connect server — YShare runs none of its own, so this is the
                person's own choice. Quiet one-liner until they open it. */}
            <View style={styles.srvBox}>
              <TouchableOpacity onPress={() => setSrvOpen(!srvOpen)} activeOpacity={0.7}>
                <Text style={styles.srvLine}>
                  QUICK CONNECT SERVER · <Text style={styles.srvValue}>{activeServer || 'NOT SET'}</Text>
                  <Text style={styles.srvAction}>{srvOpen ? '   CLOSE' : '   CHANGE'}</Text>
                </Text>
              </TouchableOpacity>
              {srvOpen ? (
                <View style={styles.srvEdit}>
                  <Text style={styles.hint}>
                    YShare has no server of its own. Nothing you send passes through us. The
                    6-character code needs a small connect-me service to introduce the two
                    devices. Run your own (see SELF-HOSTING.md) or paste one you trust. Leave it
                    empty to use Manual Connect without a Quick Connect server. Without TURN,
                    the devices still need a direct path.
                  </Text>
                  <TextInput
                    style={styles.input}
                    placeholder="wss://your-server.example:8443"
                    placeholderTextColor={C.ghost}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={signalValue}
                    onChangeText={setSignalValue}
                  />
                  <TouchableOpacity style={styles.btn} onPress={saveServer}>
                    <Text style={styles.btnText}>SAVE</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.btnGhost} onPress={removeServer}>
                    <Text style={styles.btnGhostText}>REMOVE</Text>
                  </TouchableOpacity>
                  {srvMsg ? <Text style={styles.srvMsg}>{srvMsg}</Text> : null}
                </View>
              ) : null}
            </View>
          </>
        ) : (
          <>
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <TouchableOpacity onPress={resetAll}><Text style={styles.homeBtn}>← HOME</Text></TouchableOpacity>
            <Text style={styles.logo}>
              <Text style={styles.y}>Y</Text><Text style={styles.share}>Share</Text>
            </Text>
            <Text style={styles.kicker}>PEER-TO-PEER FILE SHARING</Text>
          </View>
        </View>
        <Text style={styles.engine}>engine · {engine}</Text>
        {status !== 'idle' ? <Text style={styles.pill}>● {status}</Text> : null}

        <View style={styles.modes}>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'send' && styles.modeActive]}
            onPress={() => setMode('send')}>
            <Text style={[styles.modeText, mode === 'send' && styles.modeTextActive]}>↑ SEND A FILE</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.modeBtn, mode === 'recv' && styles.modeActive]}
            onPress={() => setMode('recv')}>
            <Text style={[styles.modeText, mode === 'recv' && styles.modeTextActive]}>↓ RECEIVE A FILE</Text>
          </TouchableOpacity>
        </View>

        {mode === 'send' ? (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>1 · Pick a file or folder</Text>
              <TouchableOpacity style={styles.btn} onPress={pickFile}>
                <Text style={styles.btnText}>CHOOSE FILE…</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.btnGhost} onPress={pickFolder}>
                <Text style={styles.btnGhostText}>CHOOSE FOLDER…</Text>
              </TouchableOpacity>
              {pickedLabel ? (
                <Text style={styles.fileInfo}>{isFolder ? '📁 ' : ''}{pickedLabel}</Text>
              ) : null}
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>2 · Password (optional)</Text>
              <Text style={styles.hint}>If set, the receiver must enter it before the file starts.</Text>
              <TextInput
                style={[styles.input, styles.passInput]}
                placeholder="(no password)"
                placeholderTextColor={C.footer}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                value={sendPass}
                onChangeText={setSendPass}
              />
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>3 · Quick connect</Text>
              <Text style={styles.hint}>Get a short code and tell it to the receiver. Everything else is automatic.</Text>
              <TouchableOpacity
                style={[styles.btn, !pickedLabel && styles.btnDisabled]}
                disabled={!pickedLabel}
                onPress={getQuickCode}>
                <Text style={[styles.btnText, !pickedLabel && styles.btnDisabledText]}>GET QUICK CODE</Text>
              </TouchableOpacity>
            </View>

            {quickCodeOut ? (
              <View style={styles.ticket}>
                <Text style={styles.ticketHead}>CLAIM TICKET</Text>
                <Text style={styles.ticketSub}>TELL THIS CODE TO THE RECEIVER</Text>
                <View style={styles.tiles}>
                  {quickCodeOut.split('').map((ch: string, i: number) => (
                    <View key={i} style={styles.tile}><Text style={styles.tileText}>{ch}</Text></View>
                  ))}
                </View>
                <Text style={styles.ticketFoot}>● VALID FOR ONE TRANSFER</Text>
              </View>
            ) : null}

            {sendActive ? (
              <TouchableOpacity style={styles.dangerBtn} onPress={cancelSend}>
                <Text style={styles.dangerText}>✕ CANCEL TRANSFER</Text>
              </TouchableOpacity>
            ) : null}

            {showManual ? (
              <>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Manual fallback · Create your code</Text>
                  <TouchableOpacity
                    style={[styles.btn, !pickedLabel && styles.btnDisabled]}
                    disabled={!pickedLabel}
                    onPress={createSendCode}>
                    <Text style={[styles.btnText, !pickedLabel && styles.btnDisabledText]}>CREATE CODE</Text>
                  </TouchableOpacity>
                  {sendCode ? (
                    <>
                      <TouchableOpacity
                        style={styles.btnGhost}
                        onPress={() => {
                          Clipboard.setString(sendCode);
                          setStatus('code copied ✓ — send it to the receiver');
                        }}>
                        <Text style={styles.btnGhostText}>COPY CODE</Text>
                      </TouchableOpacity>
                      <Text selectable numberOfLines={4} style={styles.replyText}>
                        {sendCode}
                      </Text>
                    </>
                  ) : null}
                </View>

                <View style={styles.card}>
                  <Text style={styles.cardTitle}>Manual fallback · Paste their reply, then connect</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="(paste the reply code here)"
                    placeholderTextColor={C.footer}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={replyIn}
                    onChangeText={setReplyIn}
                  />
                  <TouchableOpacity
                    style={[styles.btn, !sendCode && styles.btnDisabled]}
                    disabled={!sendCode}
                    onPress={connectAndSend}>
                    <Text style={[styles.btnText, !sendCode && styles.btnDisabledText]}>CONNECT & SEND</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>1 · Quick connect</Text>
              <Text style={styles.hint}>Type the sender's 6-character code. Everything else is automatic.</Text>
              <TextInput
                style={[styles.input, styles.quickInput]}
                placeholder="ABC123"
                placeholderTextColor={C.ghost}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={6}
                value={quickIn}
                onChangeText={(t) => setQuickIn(t.toUpperCase())}
              />
              <TouchableOpacity style={styles.btn} onPress={joinQuick}>
                <Text style={styles.btnText}>CONNECT</Text>
              </TouchableOpacity>
            </View>

            {showManual ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Manual fallback · Paste the sender's code</Text>
                <TextInput
                  style={styles.input}
                  placeholder="(paste the connector code from the sender)"
                  placeholderTextColor={C.footer}
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={code}
                  onChangeText={setCode}
                />
                <TouchableOpacity style={styles.btn} onPress={createReply}>
                  <Text style={styles.btnText}>CREATE REPLY CODE</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {reply ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>2 · Send this reply code back</Text>
                <TouchableOpacity style={styles.btnGhost} onPress={copyReply}>
                  <Text style={styles.btnGhostText}>COPY REPLY CODE</Text>
                </TouchableOpacity>
                <Text selectable style={styles.replyText}>
                  {reply}
                </Text>
              </View>
            ) : null}

            {incoming ? (
              <View style={styles.incomingCard}>
                <Text style={styles.incHead}>INCOMING PARCEL</Text>
                <View style={styles.incBody}>
                  <Text style={styles.incName}>{incoming.folder ? '📁 ' : ''}{incoming.name}</Text>
                  <Text style={styles.incSize}>
                    {incoming.folder
                      ? `Folder · ${incoming.count} file${incoming.count === 1 ? '' : 's'} · ${fmt(incoming.size)}`
                      : fmt(incoming.size)}
                  </Text>
                  {incoming.locked ? (
                    <TextInput
                      style={[styles.input, styles.passInput]}
                      placeholder="Password"
                      placeholderTextColor={C.footer}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                      value={recvPass}
                      onChangeText={setRecvPass}
                    />
                  ) : null}
                  {incMsg ? <Text style={styles.incMsg}>{incMsg}</Text> : null}
                  <TouchableOpacity
                    style={[styles.btn, acceptPending && styles.btnDisabled]}
                    disabled={acceptPending}
                    onPress={acceptIncoming}>
                    <Text style={[styles.btnText, acceptPending && styles.btnDisabledText]}>
                      {acceptPending ? 'WAITING FOR SENDER…' : '↓ ACCEPT & RECEIVE'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.dangerBtn, acceptPending && styles.btnDisabled]}
                    disabled={acceptPending}
                    onPress={declineIncoming}>
                    <Text style={styles.dangerText}>DECLINE</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : null}

            {recvActive ? (
              <TouchableOpacity style={styles.dangerBtn} onPress={cancelReceive}>
                <Text style={styles.dangerText}>✕ CANCEL TRANSFER</Text>
              </TouchableOpacity>
            ) : null}
          </>
        )}

        {flowDone ? (
          <TouchableOpacity style={styles.btnGhost} onPress={resetAll}>
            <Text style={styles.btnGhostText}>HOME</Text>
          </TouchableOpacity>
        ) : null}

        <View style={styles.transit}>
          <Text style={styles.transitLabel}>TRANSIT</Text>
          <View style={styles.lane}>
            <View style={styles.laneTrack} />
            <View style={styles.laneFillTrack}>
              <View style={[styles.laneFill, { width: `${barPct}%` }]} />
            </View>
            <View style={styles.laneDotStart} />
            <View style={styles.laneDotEnd} />
          </View>
          <View style={styles.laneEnds}>
            <Text style={styles.laneEnd}>{mode === 'send' ? 'YOU' : 'SENDER'}</Text>
            <Text style={styles.laneEnd}>{mode === 'send' ? 'RECEIVER' : 'YOU'}</Text>
          </View>
          <Text style={styles.progText}>{prog || '—'}</Text>
        </View>

        <Text style={styles.foot}>v{mobilePackage.version} · FILES GO STRAIGHT FROM YOUR DEVICE TO THEIRS</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

// "COURIER" skin (owner-designed, ported from desktop 2026-07-12): warm paper +
// ink, burnt-orange brand, Instrument Serif display + JetBrains Mono labels
// (bundled TTFs in assets/fonts), 1px ink borders, claim-ticket / parcel metaphor.
// Android refers to a bundled font by its FILE NAME (no extension).
const SERIF = 'InstrumentSerif-Regular';
const SERIF_I = 'InstrumentSerif-Italic';
const MONO = 'JetBrainsMono-Regular';
const MONO_B = 'JetBrainsMono-Bold';
const C = {
  paper: '#f4eee1', card: '#fbf7ec', cardDeep: '#f4eee1', tile: '#fffdf6', ink: '#26221c',
  body: '#55493a', muted: '#6f6455', faint: '#8a7f6d', ghost: '#a99c85', hair: '#d9cdb6',
  footer: '#a2947e', orange: '#d4551f', orangeDeep: '#b93f12', cream: '#fff7ef',
  ok: '#3d7a4f', warn: '#a06514', err: '#9c3a2a',
};
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.paper },
  content: { padding: 22, paddingTop: 40, paddingBottom: 48 },

  // ---- app header (a mode is chosen) ----
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  headerLeft: { flex: 1 },
  homeBtn: { fontFamily: MONO, color: C.muted, fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  logo: { fontSize: 34, color: C.ink, fontFamily: SERIF },
  y: { color: C.ink, fontFamily: SERIF },
  share: { color: C.orange, fontFamily: SERIF_I },
  kicker: { fontFamily: MONO, color: C.faint, fontSize: 9.5, letterSpacing: 3, marginTop: 6 },
  pill: {
    fontFamily: MONO, fontSize: 10.5, color: C.ink, backgroundColor: C.card,
    borderColor: C.ink, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 8,
    letterSpacing: 1, alignSelf: 'flex-start', marginTop: 4, marginBottom: 10,
  },
  sub: { fontFamily: MONO, color: C.faint, fontSize: 9.5, letterSpacing: 2, marginTop: 8 },
  engine: { fontFamily: MONO, color: C.footer, fontSize: 9, marginTop: 4, marginBottom: 18, letterSpacing: 1 },

  // ---- mode tabs ----
  modes: { flexDirection: 'row', gap: 10, marginBottom: 16 },
  modeBtn: {
    flex: 1, backgroundColor: 'transparent', borderColor: C.ghost, borderWidth: 1,
    borderStyle: 'dashed', paddingVertical: 13, alignItems: 'center',
  },
  modeActive: { borderColor: C.ink, borderStyle: 'solid', backgroundColor: C.card },
  modeText: { fontFamily: MONO, color: C.faint, fontSize: 11, letterSpacing: 2 },
  modeTextActive: { color: C.ink },

  // ---- cards / steps ----
  card: { backgroundColor: C.card, borderColor: C.ink, borderWidth: 1, padding: 18, marginBottom: 14 },
  cardTitle: { fontFamily: SERIF, color: C.ink, fontSize: 23, marginBottom: 8 },
  fileInfo: { fontFamily: MONO, color: C.ink, fontSize: 12, marginTop: 10 },
  hint: { fontFamily: SERIF, color: C.body, fontSize: 14, marginBottom: 10, lineHeight: 20 },

  input: {
    backgroundColor: C.tile, borderColor: C.ink, borderWidth: 1, color: C.ink,
    padding: 12, minHeight: 80, textAlignVertical: 'top', fontSize: 13, fontFamily: MONO,
  },
  passInput: { minHeight: 48, fontSize: 14, textAlignVertical: 'center' },
  quickInput: { fontSize: 24, letterSpacing: 6, minHeight: 56, textAlign: 'center', color: C.ink, fontFamily: MONO_B },

  btn: { backgroundColor: C.orange, borderColor: C.ink, borderWidth: 1, paddingVertical: 13, alignItems: 'center', marginTop: 12 },
  btnText: { fontFamily: MONO, color: C.cream, fontSize: 11.5, letterSpacing: 1.5 },
  btnGhost: { backgroundColor: 'transparent', borderColor: C.ink, borderWidth: 1, paddingVertical: 12, alignItems: 'center', marginTop: 12 },
  btnGhostText: { fontFamily: MONO, color: C.ink, fontSize: 11, letterSpacing: 1.5 },
  btnDisabled: { backgroundColor: C.cardDeep, borderColor: C.ghost, borderStyle: 'dashed' },
  btnDisabledText: { color: C.footer },
  replyText: { color: C.muted, fontSize: 10, fontFamily: MONO, marginTop: 12 },

  // ---- claim ticket (sender) ----
  ticket: { borderColor: C.ink, borderWidth: 1, backgroundColor: C.card, marginBottom: 14 },
  ticketHead: { fontFamily: MONO, color: C.cream, backgroundColor: C.orange, fontSize: 11, letterSpacing: 4, textAlign: 'center', paddingVertical: 10 },
  ticketSub: { fontFamily: MONO, color: C.faint, fontSize: 9, letterSpacing: 2, textAlign: 'center', paddingTop: 14 },
  tiles: { flexDirection: 'row', justifyContent: 'center', gap: 6, paddingVertical: 14 },
  tile: { width: 42, height: 52, borderColor: C.ink, borderWidth: 1, backgroundColor: C.tile, alignItems: 'center', justifyContent: 'center' },
  tileText: { fontFamily: MONO_B, color: C.ink, fontSize: 24 },
  ticketFoot: { fontFamily: MONO, color: C.muted, fontSize: 9, letterSpacing: 2, textAlign: 'center', paddingBottom: 12, borderTopColor: C.hair, borderTopWidth: 1, paddingTop: 10 },

  // ---- transit / progress ----
  transit: { borderColor: C.ink, borderWidth: 1, backgroundColor: C.card, padding: 18, marginTop: 14, marginBottom: 14 },
  transitLabel: { fontFamily: MONO, color: C.muted, fontSize: 10.5, letterSpacing: 3, marginBottom: 16 },
  // transit lane: dashed route between an orange "you" dot and an ink "receiver" dot,
  // with an orange fill that grows with progress (matches desktop).
  lane: { height: 10, marginBottom: 4, position: 'relative', justifyContent: 'center' },
  laneTrack: { position: 'absolute', left: 6, right: 6, top: 4, borderBottomWidth: 2, borderColor: C.ghost, borderStyle: 'dashed' },
  // the fill lives in a track inset to the two dot CENTRES (left/right 5 = dot radius),
  // so width:100% lands the orange exactly on the ink end-dot — no short-stop gap.
  laneFillTrack: { position: 'absolute', left: 5, right: 5, top: 3.5, height: 3 },
  laneFill: { height: 3, backgroundColor: C.orange },
  laneDotStart: { position: 'absolute', left: 0, top: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: C.orange },
  laneDotEnd: { position: 'absolute', right: 0, top: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: C.ink },
  laneEnds: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  laneEnd: { fontFamily: MONO, color: C.muted, fontSize: 9, letterSpacing: 1.5 },
  progText: { fontFamily: MONO, color: C.muted, fontSize: 10.5, marginTop: 12, letterSpacing: 0.5 },
  muted: { fontFamily: MONO, color: C.muted, fontSize: 10.5 },
  progressCard: { borderColor: C.ink, borderWidth: 1, backgroundColor: C.card, padding: 18, marginTop: 14, marginBottom: 14 },

  foot: { fontFamily: MONO, color: C.footer, fontSize: 10, textAlign: 'center', marginTop: 12, letterSpacing: 2 },

  // ---- danger / decline ----
  dangerBtn: { borderColor: C.err, borderWidth: 1, paddingVertical: 12, alignItems: 'center', marginTop: 12, marginBottom: 14 },
  dangerText: { fontFamily: MONO, color: C.err, fontSize: 11, letterSpacing: 1.5 },

  // ---- incoming parcel (receiver) ----
  incomingCard: { borderColor: C.ink, borderWidth: 1, backgroundColor: C.card, padding: 0, marginBottom: 14 },
  incHead: { fontFamily: MONO, color: C.cardDeep, backgroundColor: C.ink, fontSize: 11, letterSpacing: 4, textAlign: 'center', paddingVertical: 10 },
  incBody: { padding: 18 },
  incName: { fontFamily: SERIF, color: C.ink, fontSize: 23 },
  incSize: { fontFamily: MONO, color: C.muted, fontSize: 10.5, letterSpacing: 1, marginTop: 6, marginBottom: 10 },
  incMsg: { fontFamily: MONO, color: C.warn, fontSize: 10.5, marginTop: 8 },

  // ---- hero landing (no mode chosen) ----
  // compacted so the whole hero (wordmark + both cards) fits one phone screen — no scroll
  landing: { flexGrow: 1, justifyContent: 'center', alignItems: 'stretch', paddingTop: 8, paddingBottom: 8 },
  heroKicker: { fontFamily: MONO, color: C.faint, fontSize: 10, letterSpacing: 3.5, textAlign: 'center', marginBottom: 8 },
  heroLogo: { fontFamily: SERIF, fontSize: 58, color: C.ink, textAlign: 'center' },
  heroRule: { width: 76, height: 2, backgroundColor: C.orange, alignSelf: 'center', marginTop: 10, marginBottom: 12 },
  heroSub: { fontFamily: MONO, color: C.muted, fontSize: 10.5, letterSpacing: 1.5, marginBottom: 20, textAlign: 'center' },
  heroModes: { width: '100%', gap: 12 },
  heroCard: { backgroundColor: C.card, borderColor: C.ink, borderWidth: 1, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 16 },
  heroCardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  roleLabel: { fontFamily: MONO, color: C.faint, fontSize: 10, letterSpacing: 2 },
  badgeSend: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.orange, alignItems: 'center', justifyContent: 'center' },
  badgeSendY: { fontFamily: MONO_B, color: C.cream, fontSize: 15 },
  badgeRecv: { width: 40, height: 40, borderRadius: 20, borderColor: C.ghost, borderWidth: 1.5, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' },
  badgeRecvArrow: { fontFamily: MONO_B, color: C.ink, fontSize: 19 },
  heroTitle: { fontFamily: SERIF, fontSize: 38, color: C.ink, marginBottom: 4 },
  heroCopy: { fontFamily: SERIF, color: C.body, fontSize: 14, lineHeight: 19, marginBottom: 10 },
  heroLink: { fontFamily: MONO, color: C.orangeDeep, fontSize: 11, letterSpacing: 1.5 },
  // quick connect server (hero only) — quiet by default, opens into a small card
  srvBox: { width: '100%', marginTop: 22 },
  srvLine: { fontFamily: MONO, color: C.footer, fontSize: 9.5, letterSpacing: 1.5, textAlign: 'center' },
  srvValue: { color: C.muted },
  srvAction: { color: C.orangeDeep },
  srvEdit: {
    marginTop: 12, padding: 16,
    backgroundColor: C.card, borderColor: C.ghost, borderWidth: 1, borderStyle: 'dashed',
  },
  srvMsg: { fontFamily: SERIF, color: C.body, fontSize: 13, marginTop: 10, lineHeight: 18 },
});

export default App;
