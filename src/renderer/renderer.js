// YShare — renderer (the "Face"). Owns the WebRTC peer connections + data channels.
// It never touches the disk directly — it asks the main process via window.yshare.
//
// MULTI-CONNECTION TRANSFER (2026-06-26): the file is sent over N PARALLEL peer
// connections (see CHANGELOG) — split into N contiguous ranges, positioned writes
// on the receiver, one whole-file SHA-256 per side.
//
// STAGE 2+3 PRODUCT FLOW (2026-07-10): connecting no longer starts the transfer.
// After the channels open the sender OFFERS the file (offer-file on the control
// channel = the 'f0' channel); the receiver sees "Incoming: name (size)" and must
// ACCEPT before any bytes flow — with the transfer password if the sender set one.
// The password itself never travels: the receiver sends passwordProof(tid, pw) and
// the sender compares (3 attempts). Either side can cancel mid-transfer; partial
// .part files are always deleted on cancel/disconnect/failure.

const $ = (id) => document.getElementById(id);

// Tuning, relay config, code encode/decode, crypto + connection helpers all live
// in the SHARED engine (shared/engine.js) — one source of truth for desktop + mobile.
const {
  NUM_CONNS, PER_CONN_HIGH, LOW_THRESHOLD, CHUNK,
  buildRtcConfig, fetchTurnCreds, signalDial, configureSignaling,
  encodeDescs, decodeCode, connRange, waitIceComplete,
  passwordProof, newTransferId,
  validateOfferFile, validateOfferFolder, validateFileMeta, validateFolderMeta,
  validateDescriptionArray,
} = YShareEngine;
const { waitDrain, flush, createTerminalAcker, createAttemptGate } = YShareLifecycle;

const CONNECT_TIMEOUT_MS = 30000;  // ICE must land within this or we call it failed
const PASSWORD_ATTEMPTS = 3;

function setStatus(text, cls) {
  $('statusText').textContent = text;
  $('status').className = 'pill' + (cls ? ' ' + cls : '');
  $('status').style.display = '';   // hidden while idle; any real status reveals it
}

function fmt(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function fmtEta(secs) {
  if (!isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `${Math.ceil(secs)}s left`;
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  if (m < 60) return `${m}m ${s}s left`;
  return `${Math.floor(m / 60)}h ${m % 60}m left`;
}

// Manual fallback stays hidden unless quick connect actually fails (owner
// decision 2026-07-09): insurance, not a feature.
function unlockManual(which) {
  $(which).style.display = '';
}

// No server address is compiled into YShare. Quick Connect is available only when
// this install points at a signaling server the person chose themselves; until
// then the app falls back to manual codes, which need no server at all.
// Default to the closed state while main answers, so an IPC failure cannot open it.
let quickConnectReady = false;

// Single place that turns a stored setting into runtime behaviour. Also feeds the
// shared engine, so signalDial()/fetchTurnCreds() can never reach an address that
// did not pass validation here.
function applySignalState(state) {
  const ok = !!(state && state.ok);
  quickConnectReady = ok;
  configureSignaling(ok ? state.value : '', { allowInsecure: false });
  // Sending still needs something picked — enabling a server must not imply a file.
  $('btnQuickSend').disabled = !ok || !(picked || pickedFolder);
  $('btnQuickJoin').disabled = !ok;
  if (!ok) {
    unlockManual('manualSend');
    unlockManual('manualRecv');
  }
  showServerSetting(state);
  return ok;
}

const runtimeReady = window.yshare.getSignalEndpoint()
  .then((state) => {
    const ok = applySignalState(state);
    if (!ok) {
      setStatus(
        (state && state.reason)
          ? state.reason + ' — manual direct connection is available'
          : 'no quick connect server set — manual direct connection is available',
        'warn',
      );
    }
    return ok;
  })
  .catch(() => {
    applySignalState(null);
    setStatus('could not read your settings — manual direct connection is available', 'warn');
    return false;
  });

function canQuickConnect() {
  return quickConnectReady;
}

// Server-side error strings, translated for humans (CHUNK C error sweep).
function friendlyServerError(why) {
  if (why === 'no such code') return "That code isn't active — double-check it, or ask the sender for a fresh one.";
  if (why === 'room is full') return 'Someone already connected with that code — ask the sender for a new one.';
  if (why === 'rate limited') return 'Too many attempts — wait a minute and try again.';
  return 'Connection service: ' + why;
}

// --- mode switching ---------------------------------------------------------
// The app opens as a HERO landing (body.landing): big centered logo + the two
// choices, nothing else (owner's calls 2026-07-10). Picking either mode
// switches to the normal top-anchored app layout.
document.body.classList.add('landing');
$('modeSend').onclick = () => {
  document.body.classList.remove('landing');
  $('modeSend').classList.add('active'); $('modeRecv').classList.remove('active');
  $('panelSend').classList.add('show'); $('panelRecv').classList.remove('show');
};
$('modeRecv').onclick = () => {
  document.body.classList.remove('landing');
  $('modeRecv').classList.add('active'); $('modeSend').classList.remove('active');
  $('panelRecv').classList.add('show'); $('panelSend').classList.remove('show');
};

// ===========================================================================
// SENDER
// ===========================================================================
// All per-transfer sender state lives in one object so a new transfer starts clean.
let S = null;
let picked = null;        // single-file source: { name, size }; absolute path stays main-side
let pickedFolder = null;  // folder source: { name, count, totalSize, files:[{relPath,size}] }
let selectionGeneration = 0;
const senderQuickGate = createAttemptGate();

function senderQuickIsCurrent(attempt, socket = attempt && attempt.socket) {
  return senderQuickGate.isCurrent(attempt, socket)
    && (!attempt.owner || senderIsCurrent(attempt.owner));
}

function retireSenderQuickAttempt(attempt = senderQuickGate.current(), abandonOwner = false) {
  if (!attempt) return;
  senderQuickGate.retire(attempt); // retire before close so onClose is inert
  try { attempt.socket && attempt.socket.close(); } catch {}
  if (abandonOwner && attempt.owner) abandonSenderAttempt(attempt.owner);
}

function startSenderQuickAttempt() {
  return senderQuickGate.start((previous) => {
    try { previous.socket && previous.socket.close(); } catch {}
    if (previous.owner) abandonSenderAttempt(previous.owner);
  });
}

function newSenderState() {
  return {
    pcs: [], dcs: [], ctrl: null,
    tid: '', pw: '', attemptsLeft: PASSWORD_ATTEMPTS,
    sending: false, cancelled: false, finished: false, terminal: false,
    localSendComplete: false, readClosePromise: null,
    sent: 0, t0: 0,
    connectTimer: null,
    sig: null,
    opened: 0, ready: false, offerSent: false,
    payload: null,                    // immutable file/folder snapshot bound to this offer
  };
}

function senderIsCurrent(owner) {
  return !!owner && S === owner;
}

function senderIsActive(owner) {
  return senderIsCurrent(owner) && !owner.cancelled && !owner.finished && !owner.terminal;
}

function assertSenderActive(owner) {
  if (!senderIsActive(owner)) throw new Error('transfer stopped');
}

// Offer only when BOTH our channels are open AND the receiver said 'ready'.
// Offering on open alone can lose the offer on mobile: react-native-webrtc
// drops messages that arrive before the receiver's JS listener attaches (seen
// on-device 2026-07-10) — the receiver's 'ready' proves its listeners exist.
function maybeOfferFile(owner = S) {
  if (!senderIsActive(owner) || owner.offerSent) return;
  if (owner.opened === NUM_CONNS && owner.ready) {
    owner.offerSent = true;
    offerFile(owner);
  }
}

// Close every sender-side connection + the signaling socket. Old connections
// MUST be closed or they leak and gum up later transfers (bug seen 2026-07-08).
function closeSenderRead(owner) {
  if (!owner || !owner.tid) return Promise.resolve(true);
  if (!owner.readClosePromise) {
    owner.readClosePromise = window.yshare.closeRead(owner.tid).catch(() => false);
  }
  return owner.readClosePromise;
}

function senderTeardown(owner = S) {
  if (!owner) return;
  if (owner.connectTimer) { clearTimeout(owner.connectTimer); owner.connectTimer = null; }
  closeSenderRead(owner);
  if (owner.tid) window.yshare.endFileSend(owner.tid).catch(() => {});
  if (owner.tid) window.yshare.endFolderSend(owner.tid).catch(() => {});
  try { owner.sig && owner.sig.close(); } catch {}
  owner.pcs.forEach((pc) => { try { pc.close(); } catch {} });
  owner.pcs = []; owner.dcs = []; owner.ctrl = null;
}

function senderCtrlSend(obj, owner = S) {
  try {
    if (owner && owner.ctrl && owner.ctrl.readyState === 'open') {
      const message = obj && obj.type !== 'ready' && obj.tid == null && owner.tid
        ? { ...obj, tid: owner.tid }
        : obj;
      owner.ctrl.send(JSON.stringify(message));
    }
  } catch {}
}

function failSenderProtocol(reason, owner = S) {
  if (!senderIsCurrent(owner) || owner.terminal) return;
  owner.cancelled = true;
  owner.terminal = true;
  senderCtrlSend({ type: 'cancel', reason: 'invalid receiver response' }, owner);
  closeSenderRead(owner);
  setStatus('receiver sent an invalid response — stopped', 'err');
  showSendResult(false, `Transfer stopped safely: ${reason}`);
  senderFlowEnded(owner);
  setTimeout(() => senderTeardown(owner), 300);
}

// A transfer reached an end state (done/declined/cancelled/failed): let the
// sender start another one without restarting the app.
function senderFlowEnded(owner = S) {
  if (!senderIsCurrent(owner)) return;
  $('btnQuickSend').disabled = !canQuickConnect() || !(picked || pickedFolder);
  $('quickCodeOut').textContent = '';
  $('btnSendCancel').style.display = 'none';
  $('btnPick').disabled = false;
  $('btnPickFolder').disabled = false;
}

function abandonSenderAttempt(owner = S) {
  if (!senderIsCurrent(owner) || owner.sending || owner.finished || owner.terminal) return;
  owner.cancelled = true;
  owner.terminal = true;
  senderFlowEnded(owner);
  senderTeardown(owner);
}

$('btnPick').onclick = async () => {
  const generation = ++selectionGeneration;
  $('btnPick').disabled = true;
  $('btnPickFolder').disabled = true;
  try {
    const f = await window.yshare.pickFile();
    if (generation !== selectionGeneration || !f) return;
    picked = f;
    pickedFolder = null;                 // file OR folder, never both
    $('fileInfo').textContent = `${f.name} · ${fmt(f.size)}`;
    $('btnQuickSend').disabled = !canQuickConnect();
    $('btnCreateOffer').disabled = false;
  } finally {
    if (generation === selectionGeneration) {
      $('btnPick').disabled = false;
      $('btnPickFolder').disabled = false;
    }
  }
};

$('btnPickFolder').onclick = async () => {
  const generation = ++selectionGeneration;
  $('btnPick').disabled = true;
  $('btnPickFolder').disabled = true;
  try {
    const sel = await window.yshare.pickFolder();
    if (generation !== selectionGeneration || !sel) return;
    // Immediate feedback: show the chosen folder + a "scanning" note right away, since
    // reading a big folder's contents can take a few seconds (owner feedback 2026-07-12).
    picked = null; pickedFolder = null;
    $('btnQuickSend').disabled = true;
    $('fileInfo').textContent = `${sel.name} · reading folder contents…`;
    let fol;
    try {
      fol = await window.yshare.scanFolder();
    } catch (e) {
      if (generation === selectionGeneration) {
        $('fileInfo').textContent = `Could not read “${sel.name}” — try another folder.`;
      }
      return;
    }
    if (generation !== selectionGeneration) return;
    if (!fol || fol.count === 0) { $('fileInfo').textContent = `${sel.name} · (empty folder — nothing to send)`; return; }
    pickedFolder = fol;
    $('fileInfo').textContent = `${fol.name} · ${fol.count} file${fol.count === 1 ? '' : 's'} · ${fmt(fol.totalSize)}`;
    $('btnQuickSend').disabled = !canQuickConnect();
    $('btnCreateOffer').disabled = false;
  } finally {
    if (generation === selectionGeneration) {
      $('btnPick').disabled = false;
      $('btnPickFolder').disabled = false;
    }
  }
};

// Status reflects the FIRST connection's state (they connect together).
function wireSenderConn(pc, owner) {
  pc.addEventListener('connectionstatechange', () => {
    if (!senderIsCurrent(owner) || owner.terminal) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      if (owner.connectTimer) { clearTimeout(owner.connectTimer); owner.connectTimer = null; }
    } else if (s === 'failed' || s === 'disconnected') {
      if (owner.sending && !owner.finished && !owner.cancelled) {
        owner.cancelled = true;
        owner.terminal = true;
        closeSenderRead(owner);
        setStatus('connection lost mid-transfer ✗', 'err');
        showSendResult(false, 'Connection lost — the transfer did not complete. Ask the receiver to reconnect and try again.');
        senderFlowEnded(owner);
        senderTeardown(owner);
      } else if (!owner.sending && !owner.finished && s === 'failed') {
        owner.cancelled = true;
        owner.terminal = true;
        setStatus('connection failed — could not reach the receiver', 'err');
        senderFlowEnded(owner);
        senderTeardown(owner);
      }
    }
  });
}

function onSenderMsg(e, connectionIndex, owner) {
  if (typeof e.data !== 'string' || !senderIsActive(owner)) return;
  let m; try { m = JSON.parse(e.data); } catch { return; }

  if (connectionIndex !== 0) {
    failSenderProtocol('control data arrived on the wrong channel.', owner);
    return;
  }
  if (['accept', 'decline', 'cancel', 'ack'].includes(m.type)
    && (!owner.offerSent || m.tid !== owner.tid)) {
    failSenderProtocol('the receiver response did not match this transfer.', owner);
    return;
  }

  if (m.type === 'ready') {
    owner.ready = true;
    maybeOfferFile(owner);
  } else if (m.type === 'accept') {
    if (owner.sending || owner.finished || owner.cancelled) return;
    if (owner.pw) {
      if (m.auth !== passwordProof(owner.tid, owner.pw)) {
        owner.attemptsLeft -= 1;
        senderCtrlSend({ type: 'deny', left: owner.attemptsLeft }, owner);
        if (owner.attemptsLeft <= 0) {
          owner.cancelled = true;
          owner.terminal = true;
          setStatus('receiver failed the password 3 times — stopped', 'err');
          showSendResult(false, 'Wrong password entered 3 times — transfer refused and closed.');
          senderFlowEnded(owner);
          closeSenderRead(owner);
          setTimeout(() => senderTeardown(owner), 400);   // let the deny message flush out first
        } else {
          setStatus(`wrong password from receiver (${owner.attemptsLeft} attempt${owner.attemptsLeft === 1 ? '' : 's'} left)`, 'warn');
        }
        return;
      }
    }
    startSending(owner);
  } else if (m.type === 'decline') {
    owner.cancelled = true;
    owner.terminal = true;
    setStatus('receiver declined the file', 'err');
    showSendResult(false, 'The receiver declined this file.');
    senderFlowEnded(owner);
    closeSenderRead(owner);
    setTimeout(() => senderTeardown(owner), 200);
  } else if (m.type === 'cancel') {
    if (!owner.finished) {
      owner.cancelled = true;
      owner.terminal = true;
      setStatus('receiver cancelled ✗', 'err');
      showSendResult(false, 'The receiver cancelled the transfer.');
      senderFlowEnded(owner);
      closeSenderRead(owner);
      setTimeout(() => senderTeardown(owner), 200);
    }
  } else if (m.type === 'ack') {
    if (!owner.sending || !owner.localSendComplete || typeof m.ok !== 'boolean') {
      failSenderProtocol('the completion message was invalid or arrived before the local send completed.', owner);
      return;
    }
    owner.finished = true;
    owner.terminal = true;
    senderFlowEnded(owner);
    const what = owner.payload && owner.payload.kind === 'folder' ? 'folder' : 'file';
    showSendResult(m.ok, m.ok
      ? `Receiver verified the ${what} ✓ — transfer complete.`
      : `Receiver could not save or verify the ${what}${m.reason ? `: ${String(m.reason).slice(0, 180)}` : '.'}`);
    setStatus(m.ok ? 'done ✓' : 'receiver reported failure', m.ok ? 'on' : 'err');
    senderTeardown(owner);
  } else {
    failSenderProtocol('the receiver sent an unknown response.', owner);
  }
}

function showSendResult(ok, text) {
  $('sendResult').className = 'result ' + (ok ? 'ok' : 'bad');
  $('sendResult').textContent = text;
  $('btnSendNew').style.display = '';   // every end state offers a fresh start
  // A reset button below the fold is a hidden button — bring it into view.
  $('btnSendNew').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Build the N sender connections + offers with the given RTC config; returns the
// encoded offers code. Shared by the manual and quick flows.
async function buildOffers(rtcConfig, quickAttempt = null) {
  if (quickAttempt) {
    if (!senderQuickIsCurrent(quickAttempt, quickAttempt.socket)) throw new Error('quick attempt was replaced');
  } else {
    retireSenderQuickAttempt();
  }
  senderTeardown(S);                 // never leak the previous attempt's connections
  const owner = newSenderState();
  S = owner;
  if (quickAttempt) quickAttempt.owner = owner;
  owner.payload = pickedFolder
    ? { kind: 'folder', value: pickedFolder }
    : picked ? { kind: 'file', value: picked } : null;
  if (!owner.payload) throw new Error('nothing selected');
  owner.tid = newTransferId();
  owner.pw = $('sendPass').value.trim();
  if (owner.payload.kind === 'folder') {
    await window.yshare.beginFolderSend(owner.tid);
    assertSenderActive(owner);
  } else {
    await window.yshare.beginFileSend(owner.tid);
    assertSenderActive(owner);
  }
  $('btnPick').disabled = true;
  $('btnPickFolder').disabled = true;
  $('sendResult').textContent = '';
  $('sendBar').style.width = '0%';
  $('sendProg').textContent = '—';

  for (let i = 0; i < NUM_CONNS; i++) {
    const pc = new RTCPeerConnection(rtcConfig);
    wireSenderConn(pc, owner);
    const dc = pc.createDataChannel('f' + i, { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = LOW_THRESHOLD;
    dc.onmessage = (event) => onSenderMsg(event, i, owner);
    dc.onopen = () => {
      if (!senderIsActive(owner)) return;
      owner.opened += 1;
      maybeOfferFile(owner);
    };
    if (i === 0) owner.ctrl = dc;
    owner.pcs.push(pc); owner.dcs.push(dc);
  }

  // Create offers + gather ICE for all connections in parallel.
  await Promise.all(owner.pcs.map(async (pc) => {
    const offer = await pc.createOffer();
    assertSenderActive(owner);
    await pc.setLocalDescription(offer);
    assertSenderActive(owner);
    await waitIceComplete(pc);
    assertSenderActive(owner);
  }));

  assertSenderActive(owner);
  return encodeDescs(owner.pcs.map((pc) => pc.localDescription));
}

// Apply the receiver's answers to the sender connections. Shared by both flows.
async function applyAnswers(answers, owner = S) {
  const checked = validateDescriptionArray(answers, 'answer');
  if (!senderIsActive(owner) || checked.length !== owner.pcs.length) throw new Error('connection count changed');
  await Promise.all(owner.pcs.map(async (pc, i) => {
    await pc.setRemoteDescription(checked[i]);
    assertSenderActive(owner);
  }));
  assertSenderActive(owner);
  setStatus('connecting…', 'warn');
  owner.connectTimer = setTimeout(() => {
    if (senderIsCurrent(owner) && !owner.sending && !owner.finished && !owner.terminal) {
      owner.cancelled = true;
      owner.terminal = true;
      setStatus('could not connect (30s) — check both sides are online and try again', 'err');
      senderFlowEnded(owner);
      senderTeardown(owner);
    }
  }, CONNECT_TIMEOUT_MS);
}

// All channels open → offer the file (or folder) and wait for the receiver's decision.
function offerFile(owner = S) {
  if (!senderIsActive(owner)) return;
  setStatus('connected — waiting for the receiver to accept…', 'on');
  const payload = owner.payload;
  if (!payload) return failSenderProtocol('the selected item is no longer available.', owner);
  if (payload.kind === 'folder') {
    const folder = payload.value;
    senderCtrlSend({
      type: 'offer-folder',
      tid: owner.tid,
      name: folder.name,
      count: folder.count,
      totalSize: folder.totalSize,
      locked: !!owner.pw,
    }, owner);
  } else {
    const file = payload.value;
    senderCtrlSend({
      type: 'offer-file',
      tid: owner.tid,
      name: file.name,
      size: file.size,
      locked: !!owner.pw,
    }, owner);
  }
}

async function startSending(owner = S) {
  if (!senderIsActive(owner) || owner.sending) return;             // guard: fire once
  owner.sending = true;
  $('btnSendCancel').style.display = '';
  if (!owner.payload) return failSenderProtocol('the offered item is missing.', owner);
  if (owner.payload.kind === 'folder') return startSendingFolder(owner);
  const file = owner.payload.value;
  setStatus('preparing (hashing the file)…', 'on');
  try {
    await window.yshare.openRead(owner.tid);
    assertSenderActive(owner);
    const size = file.size;
    const hash = await window.yshare.hashFile(owner.tid);   // whole-file hash up front
    assertSenderActive(owner);

    setStatus('sending…', 'on');
    owner.sent = 0; owner.t0 = performance.now();
    // Split the file into NUM_CONNS contiguous ranges; stream them all in parallel.
    await Promise.all(owner.dcs.map((dc, i) => {
      const { start, end } = connRange(i, size, NUM_CONNS);
      assertSenderActive(owner);
      dc.send(JSON.stringify({ type: 'meta', tid: owner.tid, name: file.name, size, hash, start, end }));
      return sendRange(owner, dc, start, end, size);
    }));

    assertSenderActive(owner);
    await Promise.all(owner.dcs.map((dc) => flush(dc, () => !senderIsActive(owner))));
    assertSenderActive(owner);
    owner.localSendComplete = true;
    setStatus('sent — waiting for receiver to verify', 'on');
  } catch (err) {
    // Source file gone/unreadable mid-transfer, or a channel died under us.
    if (senderIsCurrent(owner) && !owner.cancelled && !owner.finished && !owner.terminal) {
      owner.cancelled = true;
      owner.terminal = true;
      senderCtrlSend({ type: 'cancel' }, owner);
      setStatus('send failed ✗', 'err');
      showSendResult(false, `Could not read the file (was it moved or deleted?) — transfer stopped. (${err.message || err})`);
      senderFlowEnded(owner);
      setTimeout(() => senderTeardown(owner), 300);
    }
  } finally {
    await closeSenderRead(owner);
    if (senderIsCurrent(owner) && owner.cancelled) $('btnSendCancel').style.display = 'none';
  }
}

// Folder send: stream files ONE AT A TIME, each split across the N connections
// (reuses sendRange + the single read handle). Progress + speed accumulate against
// the whole-folder total. A per-connection `file-meta` header precedes each file's
// range bytes so the receiver knows which file/offset the bytes belong to.
async function startSendingFolder(owner = S) {
  const folder = owner && owner.payload && owner.payload.kind === 'folder' ? owner.payload.value : null;
  if (!folder) return failSenderProtocol('the offered folder is missing.', owner);
  const files = folder.files;
  const total = folder.totalSize;
  owner.sent = 0; owner.t0 = performance.now();
  setStatus(`preparing folder “${folder.name}”…`, 'on');
  try {
    for (let i = 0; i < files.length; i++) {
      assertSenderActive(owner);
      const file = files[i];
      await window.yshare.openReadFile(owner.tid, i);
      assertSenderActive(owner);
      const hash = await window.yshare.hashFileIdx(owner.tid, i);   // per-file integrity hash
      assertSenderActive(owner);
      setStatus(`sending… file ${i + 1}/${files.length}: ${file.relPath}`, 'on');
      await Promise.all(owner.dcs.map((dc, k) => {
        const { start, end } = connRange(k, file.size, NUM_CONNS);
        assertSenderActive(owner);
        dc.send(JSON.stringify({
          type: 'file-meta', idx: i, relPath: file.relPath,
          tid: owner.tid, size: file.size, hash, start, end, count: files.length,
        }));
        return sendRange(owner, dc, start, end, total);   // reads the CURRENT file; owner.sent vs folder total
      }));
      assertSenderActive(owner);
      await Promise.all(owner.dcs.map((dc) => flush(dc, () => !senderIsActive(owner))));
      assertSenderActive(owner);
      await window.yshare.closeRead(owner.tid);
      owner.readClosePromise = null;
      assertSenderActive(owner);
    }
    assertSenderActive(owner);
    senderCtrlSend({ type: 'folder-sent', tid: owner.tid, count: files.length }, owner);
    await flush(owner.ctrl, () => !senderIsActive(owner));
    assertSenderActive(owner);
    owner.localSendComplete = true;
    setStatus('sent — waiting for receiver to verify', 'on');
  } catch (err) {
    if (senderIsCurrent(owner) && !owner.cancelled && !owner.finished && !owner.terminal) {
      owner.cancelled = true;
      owner.terminal = true;
      senderCtrlSend({ type: 'cancel' }, owner);
      setStatus('send failed ✗', 'err');
      showSendResult(false, `Could not read the folder (was it moved or changed?) — transfer stopped. (${err.message || err})`);
      senderFlowEnded(owner);
      setTimeout(() => senderTeardown(owner), 300);
    }
  } finally {
    await closeSenderRead(owner);
    if (senderIsCurrent(owner) && owner.cancelled) $('btnSendCancel').style.display = 'none';
  }
}

async function sendRange(owner, dc, start, end, totalSize) {
  let offset = start;
  while (offset < end) {
    assertSenderActive(owner);
    if (dc.readyState !== 'open') throw new Error('data channel closed during transfer');
    if (dc.bufferedAmount > PER_CONN_HIGH) {
      await waitDrain(dc, () => !senderIsActive(owner));
      assertSenderActive(owner);
    }
    const len = Math.min(CHUNK, end - offset);
    const chunk = await window.yshare.readChunk(owner.tid, offset, len);
    assertSenderActive(owner);
    if (!chunk || chunk.byteLength !== len) throw new Error('source file changed or ended early');
    dc.send(chunk);
    offset += len;
    owner.sent += len;
    if (senderIsCurrent(owner)) updateProgress('send', owner.sent, totalSize, owner.t0);
  }
}

$('btnSendCancel').onclick = () => {
  const owner = S;
  if (!senderIsCurrent(owner) || owner.finished || owner.terminal) return;
  owner.cancelled = true;
  owner.terminal = true;
  senderCtrlSend({ type: 'cancel' }, owner);
  closeSenderRead(owner);
  setStatus('cancelled', 'err');
  showSendResult(false, 'Transfer cancelled.');
  senderFlowEnded(owner);
  senderTeardownAfterFlush(owner);   // the cancel is queued behind buffered file bytes
};

// Mid-transfer the control channel holds up to a high-water mark of file bytes;
// a fixed grace period tore the connection down before the queued 'cancel'
// reached the receiver (it then showed "connection lost" instead of "sender
// cancelled" — seen on-device 2026-07-10). Wait for the actual drain, capped.
async function senderTeardownAfterFlush(owner) {
  const dc = owner && owner.ctrl;
  const t0 = Date.now();
  while (dc && dc.readyState === 'open' && dc.bufferedAmount > 0 && Date.now() - t0 < 3000) {
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 200));   // let the final frame hit the wire
  senderTeardown(owner);
}

// --- quick connect (sender): room code from the signaling server -------------
$('btnQuickSend').onclick = async () => {
  if (!picked && !pickedFolder) return;
  $('btnQuickSend').disabled = true;
  const attempt = startSenderQuickAttempt();
  // Wait for the first settings read, then judge the LIVE state: someone who just
  // saved a server must not have to restart the app before Quick Connect works.
  await runtimeReady;
  if (!canQuickConnect()) {
    if (!senderQuickIsCurrent(attempt, null)) return;
    senderQuickGate.retire(attempt);
    unlockManual('manualSend');
    setStatus('quick connect needs a server — set one on the home screen, or use the manual code below', 'warn');
    return;
  }
  if (!senderQuickIsCurrent(attempt, null)) return;
  $('quickCodeOut').textContent = '';   // never show a stale code from a dead room
  setStatus('contacting connect server…', 'warn');
  let sig = null, quickTurn = null;
  try {
    sig = await signalDial();
  } catch (e) {
    if (!senderQuickIsCurrent(attempt, null)) return;
    senderQuickGate.retire(attempt);
    setStatus('quick connect unavailable — manual codes unlocked below', 'err');
    unlockManual('manualSend');
    $('btnQuickSend').disabled = !canQuickConnect();
    return;
  }
  if (!senderQuickGate.bindSocket(attempt, sig)) {
    try { sig.close(); } catch {}
    return;
  }
  // The room dies with this socket (server sweep / network blip). Without this
  // handler the app kept showing a dead code forever (seen 2026-07-10).
  sig.onClose = () => {
    if (!senderQuickIsCurrent(attempt, sig)) return;
    senderQuickGate.retire(attempt);
    if (attempt.handshakeDone) return;
    if (attempt.owner) abandonSenderAttempt(attempt.owner);
    setStatus('lost the connection to the code server — get a new quick code', 'err');
    $('quickCodeOut').textContent = '';
    $('btnQuickSend').disabled = !canQuickConnect() || !(picked || pickedFolder);
  };
  sig.onMessage = async (m) => {
    if (!senderQuickIsCurrent(attempt, sig)) return;
    if (attempt.processing) {
      senderQuickGate.retire(attempt);
      try { sig.close(); } catch {}
      if (attempt.owner) abandonSenderAttempt(attempt.owner);
      setStatus('quick connect received overlapping server messages — try again', 'err');
      unlockManual('manualSend');
      $('btnQuickSend').disabled = !canQuickConnect();
      return;
    }
    attempt.processing = true;
    try {
      if (m.t === 'created') {
        quickTurn = m.turn;
        $('quickCodeOut').textContent = m.code;
        setStatus(`quick code ${m.code} — tell it to the receiver`, 'warn');
      } else if (m.t === 'peer') {
        setStatus('receiver joined — connecting…', 'warn');
        const code = await buildOffers(buildRtcConfig(quickTurn), attempt);
        if (!senderQuickIsCurrent(attempt, sig)) return;
        const owner = attempt.owner;
        assertSenderActive(owner);
        owner.sig = sig;               // so teardown closes it
        sig.send({ t: 'msg', data: { kind: 'offers', code } });
      } else if (m.t === 'msg' && m.data && m.data.kind === 'answers') {
        const owner = attempt.owner;
        if (!owner) throw new Error('answers arrived before offers were created');
        await applyAnswers(decodeCode(m.data.code), owner);
        if (!senderQuickIsCurrent(attempt, sig) || !senderIsCurrent(owner)) return;
        sig.send({ t: 'done' });   // handshake delivered — the room can go
        attempt.handshakeDone = true;
        senderQuickGate.retire(attempt);
        sig.close();
      } else if (m.t === 'err') {
        senderQuickGate.retire(attempt);
        if (attempt.owner) abandonSenderAttempt(attempt.owner);
        setStatus(friendlyServerError(m.why), 'err');
        unlockManual('manualSend');
        $('btnQuickSend').disabled = !canQuickConnect();
      }
    } catch (e) {
      if (!senderQuickIsCurrent(attempt, sig)) return;
      senderQuickGate.retire(attempt);
      if (attempt.owner) abandonSenderAttempt(attempt.owner);
      setStatus('quick connect failed — manual codes unlocked below', 'err');
      unlockManual('manualSend');
      $('btnQuickSend').disabled = !canQuickConnect();
    } finally {
      attempt.processing = false;
    }
  };
  if (!senderQuickIsCurrent(attempt, sig)) return;
  sig.send({ t: 'create' });
};

// --- manual fallback (sender) -------------------------------------------------
$('btnCreateOffer').onclick = async () => {
  const attempt = startSenderQuickAttempt();
  $('btnCreateOffer').disabled = true;
  setStatus('creating codes…', 'warn');
  try {
    await runtimeReady;
    const serverReady = canQuickConnect();
    if (!senderQuickIsCurrent(attempt, null)) return;
    // With no configured server there is nowhere to ask for relay credentials —
    // the manual code is then direct/STUN-only, which still works for most pairs.
    const turn = serverReady ? await fetchTurnCreds() : null;
    if (!senderQuickIsCurrent(attempt, null)) return;
    const code = await buildOffers(buildRtcConfig(turn), attempt);
    if (!senderQuickIsCurrent(attempt, null)) return;
    $('offerOut').value = code;
    $('btnConnectSend').disabled = false;
    setStatus('code created — send it to the receiver' + (turn ? '' : ' (direct connection only)'), 'warn');
    senderQuickGate.retire(attempt);
  } catch (err) {
    if (!senderQuickIsCurrent(attempt, null)) return;
    senderQuickGate.retire(attempt);
    if (attempt.owner) abandonSenderAttempt(attempt.owner);
    setStatus('could not create the connection code — try again', 'err');
  } finally {
    $('btnCreateOffer').disabled = false;
  }
};

$('btnCopyOffer').onclick = () => navigator.clipboard.writeText($('offerOut').value);

$('btnConnectSend').onclick = async () => {
  $('btnConnectSend').disabled = true;   // guard against double-click
  try {
    const owner = S;
    await applyAnswers(decodeCode($('answerIn').value), owner);
  } catch (err) {
    setStatus("that reply code doesn't look right — copy it again and paste the whole thing", 'err');
    $('btnConnectSend').disabled = false;
  }
};

// ===========================================================================
// RECEIVER
// ===========================================================================
let R = null;
const receiverQuickGate = createAttemptGate();

function receiverQuickIsCurrent(attempt, socket = attempt && attempt.socket) {
  return receiverQuickGate.isCurrent(attempt, socket)
    && (!attempt.owner || receiverIsCurrent(attempt.owner));
}

function retireReceiverQuickAttempt(attempt = receiverQuickGate.current(), abandonOwner = false) {
  if (!attempt) return;
  receiverQuickGate.retire(attempt); // retire before close so onClose is inert
  try { attempt.socket && attempt.socket.close(); } catch {}
  if (abandonOwner && attempt.owner) abandonReceiverAttempt(attempt.owner);
}

function startReceiverQuickAttempt() {
  return receiverQuickGate.start((previous) => {
    try { previous.socket && previous.socket.close(); } catch {}
    if (previous.owner) abandonReceiverAttempt(previous.owner);
  });
}

function newReceiverState() {
  const owner = {
    pcs: [], ctrl: null,
    offer: null,                    // validated, immutable offer accepted by the owner
    accepted: false, preparingAccept: false, finished: false, cancelled: false, finalizing: false,
    protocolFailed: false, terminal: null, abortPromise: null, finalizePromise: null,
    sendTerminalAck: null,
    size: 0, hash: null, received: 0, t0: 0, receiveStarted: false,
    openPromise: null,
    chanState: new Map(),           // dataChannel -> validated range + write queue
    channelIndexes: new Set(),
    singleMeta: null,
    singleMetaChannels: new Set(),
    singleDoneChannels: new Set(),
    connectTimer: null,
    sig: null,
    // --- folder receive (CHUNK D) ---
    folder: null,                   // { name, count, totalSize } once a folder is offered
    folderOpen: false, folderOpenPromise: null, folderBasePath: null, folderSent: false,
    filesOpening: new Map(),        // idx -> Promise (openWriteFile in flight/done)
    fileMeta: new Map(),            // idx -> canonical metadata + connection sets
    folderPathOwners: new Map(),
    fileReceived: new Map(),        // idx -> bytes written so far
    fileWriteQ: new Map(),          // idx -> Promise chain of positioned writes
    fileDone: new Set(),            // idx already finalized
    fileFinalizers: new Map(),      // idx -> finish/verify promise (included in cleanup)
    filesStarted: new Set(),        // idx seen (for the "file X of N" status)
    filesTotalDone: 0, folderHadError: false, folderDeclaredSize: 0,
  };
  owner.sendTerminalAck = createTerminalAcker((message) => recvCtrlSend(message, owner));
  return owner;
}

function receiverIsCurrent(owner) {
  return !!owner && R === owner;
}

function receiverTeardown(owner = R) {
  if (!owner) return;
  if (owner.connectTimer) { clearTimeout(owner.connectTimer); owner.connectTimer = null; }
  try { owner.sig && owner.sig.close(); } catch {}
  owner.pcs.forEach((pc) => { try { pc.close(); } catch {} });
  owner.pcs = []; owner.ctrl = null;
}

function abandonReceiverAttempt(owner = R) {
  if (!receiverIsCurrent(owner) || owner.accepted || owner.finished || owner.cancelled) return;
  owner.cancelled = true;
  owner.terminal = 'failed';
  receiverTeardown(owner);
}

function recvCtrlSend(obj, owner = R) {
  try {
    if (owner && owner.ctrl && owner.ctrl.readyState === 'open') {
      const message = obj && obj.type !== 'ready' && obj.tid == null && owner.offer && owner.offer.tid
        ? { ...obj, tid: owner.offer.tid }
        : obj;
      owner.ctrl.send(JSON.stringify(message));
    }
  } catch {}
}

function sendReceiverAckOnce(owner, ok, reason) {
  if (!owner || !owner.offer) return false;
  return owner.sendTerminalAck({
    type: 'ack',
    ok: !!ok,
    reason: ok ? undefined : reason,
  });
}

function showRecvResult(ok, text) {
  $('recvResult').className = 'result ' + (ok ? 'ok' : 'bad');
  $('recvResult').textContent = text;
  $('btnRecvNew').style.display = '';   // every end state offers a fresh start
  $('btnRecvNew').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// "New transfer" = a genuine fresh start: reloading the renderer closes every
// connection and clears every field — the next transfer can't inherit anything.
let reloadInProgress = false;

async function cleanupAndReload() {
  if (reloadInProgress) return;
  reloadInProgress = true;
  retireSenderQuickAttempt();
  retireReceiverQuickAttempt();
  const senderOwner = S;
  const receiverOwner = R;
  if (senderOwner && !senderOwner.finished && !senderOwner.cancelled) {
    senderOwner.cancelled = true;
    senderOwner.terminal = true;
    senderCtrlSend({ type: 'cancel' }, senderOwner);
    closeSenderRead(senderOwner);
  }
  if (receiverOwner && receiverOwner.terminal === 'completing' && receiverOwner.finalizePromise) {
    // The verified file/folder is in the tiny atomic commit step. Let that
    // settle before global cleanup so Home/reload cannot delete a true success.
    await receiverOwner.finalizePromise.catch(() => {});
  } else if (receiverOwner && !receiverOwner.finished && !receiverOwner.cancelled) {
    receiverOwner.cancelled = true;
    receiverOwner.terminal = receiverOwner.terminal || 'cancelled';
    recvCtrlSend({ type: 'cancel' }, receiverOwner);
  }
  await window.yshare.cleanupTransfers().catch(() => false);
  senderTeardown(senderOwner);
  receiverTeardown(receiverOwner);
  location.reload();
}

$('btnSendNew').onclick = cleanupAndReload;
$('btnRecvNew').onclick = cleanupAndReload;

// Persistent "← Home" — return to the hero from any panel at any time (owner's
// request). Reloading gives a guaranteed-clean hero. If a real transfer is in
// flight, confirm first so it isn't cancelled by accident.
$('btnHome').onclick = async () => {
  const active = (S && S.sending && !S.finished && !S.cancelled) ||
                 (R && R.accepted && !R.finished && !R.cancelled);
  if (active && !confirm('A transfer is in progress — leave and cancel it?')) return;
  await cleanupAndReload();
};

// Ctrl+R / an external navigation cannot await renderer work. Ask main to clean
// up anyway; BrowserWindow's close guard is the final fallback for window exit.
window.addEventListener('pagehide', () => { window.yshare.cleanupTransfers().catch(() => {}); });

// Abort an in-progress receive: delete the partial file, tell the sender (if
// `notify`), reset the incoming card.
async function cleanupOutcomeText(cleaned, kind) {
  if (cleaned) return 'No incomplete local data remains.';
  const saveDir = await window.yshare.getDownloadDir().catch(() => null);
  const leftover = kind === 'folder' ? 'partial folder or .part files' : '.part file or incomplete saved file';
  const where = saveDir ? ` from ${saveDir}` : ' from your YShare save folder';
  return `Cleanup could not be confirmed. Close YShare and manually delete any leftover ${leftover}${where}.`;
}

async function abortReceive(owner, notify, statusText, resultText, terminal = 'cancelled') {
  if (!owner || owner.finished) return true;
  if (owner.abortPromise) return owner.abortPromise;
  owner.cancelled = true;
  owner.terminal = owner.terminal || terminal;
  if (notify) recvCtrlSend({ type: 'cancel' }, owner);
  if (receiverIsCurrent(owner)) {
    $('incomingCard').style.display = 'none';
    $('btnRecvCancel').style.display = 'none';
  }
  owner.abortPromise = (async () => {
    const pending = [
      ...[...owner.chanState.values()].map((state) => state.writeQ),
      ...owner.fileWriteQ.values(),
      ...owner.filesOpening.values(),
      ...owner.fileFinalizers.values(),
    ];
    if (owner.openPromise) pending.push(owner.openPromise);
    if (owner.folderOpenPromise) pending.push(owner.folderOpenPromise);
    if (owner.finalizePromise) pending.push(owner.finalizePromise);
    await Promise.allSettled(pending);
    // folder → delete the whole partial folder; single file → delete the .part
    const tid = owner.offer && owner.offer.tid;
    const cleaned = owner.folder
      ? await window.yshare.abortFolder(tid).catch(() => false)
      : await window.yshare.abortWrite(tid).catch(() => false);
    const cleanupText = await cleanupOutcomeText(cleaned, owner.folder ? 'folder' : 'file');
    if (receiverIsCurrent(owner)) {
      setStatus(statusText, 'err');
      if (resultText) showRecvResult(false, `${resultText} ${cleanupText}`);
    }
    setTimeout(() => receiverTeardown(owner), 300);
    return cleaned;
  })();
  return owner.abortPromise;
}

function protocolMessage(err) {
  const text = err && err.message ? err.message : String(err || 'invalid transfer data');
  return text.replace(/^Invalid transfer metadata:\s*/i, '').slice(0, 180);
}

async function failReceive(owner, reason, label = 'invalid transfer data') {
  if (!receiverIsCurrent(owner) || owner.finished || owner.cancelled || owner.protocolFailed) return;
  owner.protocolFailed = true;
  owner.terminal = 'failed';
  const detail = protocolMessage(reason);
  sendReceiverAckOnce(owner, false, label);
  await abortReceive(owner, false, 'unsafe or invalid transfer rejected ✗',
    `YShare rejected the transfer before it could be trusted: ${detail}.`, 'failed');
}

// --- folder receive: finalize one file, then maybe the whole folder ----------
function maybeFinalizeFolderFile(owner, idx) {
  if (!receiverIsCurrent(owner) || owner.cancelled || owner.fileDone.has(idx)) return;
  const meta = owner.fileMeta.get(idx);
  if (!meta || meta.seenConnections.size !== NUM_CONNS || meta.doneConnections.size !== NUM_CONNS) return;
  if ((owner.fileReceived.get(idx) || 0) !== meta.size) {
    failReceive(owner, 'folder file byte count did not match its metadata');
    return;
  }
  owner.fileDone.add(idx);
  const base = owner.fileWriteQ.get(idx) || owner.filesOpening.get(idx) || Promise.resolve();
  const finalizer = base
    .then(() => {
      if (!receiverIsCurrent(owner) || owner.cancelled) return null;
      return window.yshare.finishWriteFile(owner.offer.tid, idx, meta.hash);
    })
    .then((res) => {
      if (!receiverIsCurrent(owner) || owner.cancelled || !res) return;
      owner.filesTotalDone += 1;
      if (!res || !res.ok) {
        owner.folderHadError = true;
        if (res && res.error) meta.error = res.error;
      }
      maybeFinalizeFolder(owner);
    })
    .catch((err) => {
      if (!receiverIsCurrent(owner) || owner.cancelled) return;
      owner.folderHadError = true;
      meta.error = err && err.message ? err.message : 'disk write failed';
      owner.filesTotalDone += 1;
      maybeFinalizeFolder(owner);
    });
  owner.fileFinalizers.set(idx, finalizer);
}

function maybeFinalizeFolder(owner) {
  if (!receiverIsCurrent(owner) || owner.finished || owner.cancelled || owner.finalizing || !owner.folderSent) return;
  if (!owner.folder || owner.fileMeta.size !== owner.folder.count || owner.filesTotalDone < owner.folder.count) return;
  const declaredTotal = [...owner.fileMeta.values()].reduce((sum, meta) => sum + meta.size, 0);
  if (declaredTotal !== owner.folder.totalSize || owner.received !== owner.folder.totalSize) {
    failReceive(owner, 'folder totals did not match the accepted offer');
    return;
  }
  owner.finalizing = true;
  owner.finalizePromise = (async () => {
    let ok = !owner.folderHadError;
    let reason = [...owner.fileMeta.values()].find((meta) => meta.error)?.error || 'a file failed verification or saving';
    if (ok) {
      try {
        await owner.folderOpenPromise;
        if (!receiverIsCurrent(owner) || owner.cancelled) return;
        // All expensive work is complete. Lock the terminal result before the
        // tiny commit IPC so a late Cancel cannot race a success ACK.
        owner.terminal = 'completing';
        if (receiverIsCurrent(owner)) $('btnRecvCancel').style.display = 'none';
        await window.yshare.completeFolder(owner.offer.tid);
      } catch (err) {
        ok = false;
        reason = err && err.message ? err.message : 'could not finish the folder';
      }
    }
    if (!receiverIsCurrent(owner) || owner.cancelled) return;
    let cleanupConfirmed = true;
    if (!ok) {
      owner.terminal = 'failed';
      cleanupConfirmed = await window.yshare.abortFolder(owner.offer.tid).catch(() => false);
    } else {
      owner.terminal = 'completed';
    }
    if (!receiverIsCurrent(owner) || owner.cancelled) return;
    owner.finished = true;
    owner.finalizing = false;
    $('btnRecvCancel').style.display = 'none';
    const cleanupText = ok ? '' : await cleanupOutcomeText(cleanupConfirmed, 'folder');
    if (!receiverIsCurrent(owner) || owner.cancelled) return;
    showRecvResult(ok, ok
      ? `Received & verified ✓ — folder saved to ${owner.folderBasePath}`
      : `The folder could not be saved: ${reason}. ${cleanupText}`);
    setStatus(ok ? 'done ✓' : 'folder receive failed', ok ? 'on' : 'err');
    sendReceiverAckOnce(owner, ok, ok ? undefined : 'folder verification or save failed');
    setTimeout(() => receiverTeardown(owner), 500);
  })().finally(() => { owner.finalizing = false; });
}

// Answer a decoded offers array with the given RTC config; returns the encoded
// reply code. Shared by the manual and quick flows.
async function answerOffers(offers, rtcConfig, quickAttempt = null) {
  if (quickAttempt) {
    if (!receiverQuickIsCurrent(quickAttempt, quickAttempt.socket)) throw new Error('quick attempt was replaced');
  } else {
    retireReceiverQuickAttempt();
  }
  const checkedOffers = validateDescriptionArray(offers, 'offer');
  if (R && !R.finished && !R.cancelled) throw new Error('a receive connection is already active');
  receiverTeardown(R);               // never leak the previous transfer's connections
  const owner = newReceiverState();
  R = owner;
  if (quickAttempt) quickAttempt.owner = owner;
  $('recvResult').textContent = '';
  $('recvBar').style.width = '0%';
  $('recvProg').textContent = '—';
  $('incomingCard').style.display = 'none';

  try {
    await Promise.all(checkedOffers.map(async (offer, i) => {
      const pc = new RTCPeerConnection(rtcConfig);
      owner.pcs[i] = pc;
      wireReceiverConn(pc, owner);
      pc.ondatachannel = (e) => wireReceiver(e.channel, i, owner);
      await pc.setRemoteDescription(offer);
      if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
      const ans = await pc.createAnswer();
      if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
      await pc.setLocalDescription(ans);
      if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
      await waitIceComplete(pc);
      if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
    }));
  } catch (err) {
    owner.cancelled = true;
    owner.terminal = 'failed';
    receiverTeardown(owner);
    throw err;
  }

  owner.connectTimer = setTimeout(() => {
    if (receiverIsCurrent(owner) && !owner.offer && !owner.finished && !owner.cancelled) {
      owner.cancelled = true;
      owner.terminal = 'failed';
      setStatus('could not connect (30s) — check both sides are online and try again', 'err');
      receiverTeardown(owner);
      $('btnQuickJoin').disabled = !canQuickConnect();
    }
  }, CONNECT_TIMEOUT_MS);

  if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
  return encodeDescs(owner.pcs.map((pc) => pc.localDescription));
}

function wireReceiverConn(pc, owner) {
  pc.addEventListener('connectionstatechange', () => {
    if (!receiverIsCurrent(owner) || owner.finished || owner.cancelled) return;
    const s = pc.connectionState;
    if (s === 'connected') {
      if (owner.connectTimer) { clearTimeout(owner.connectTimer); owner.connectTimer = null; }
      setStatus('connected', 'on');
    } else if (s === 'connecting') {
      setStatus('connecting…', 'warn');
    } else if (s === 'failed' || s === 'disconnected') {
      if (owner.accepted && !owner.finished && !owner.cancelled) {
        abortReceive(owner, false, 'connection lost mid-transfer ✗',
          'Transfer interrupted. Ask the sender to send again.');
      } else if (!owner.finished && s === 'failed') {
        owner.cancelled = true;
        owner.terminal = 'failed';
        setStatus('connection failed — could not reach the sender', 'err');
        receiverTeardown(owner);
      }
    }
  });
}

function markReceiveStarted(owner) {
  if (!receiverIsCurrent(owner) || owner.cancelled) return;
  if (!owner.receiveStarted) {
    owner.receiveStarted = true;
    owner.t0 = performance.now();
  }
  $('incomingCard').style.display = 'none';
  $('btnRecvCancel').style.display = '';
  setStatus('receiving…', 'on');
}

function ensureFolderOpen(owner) {
  if (owner.folderOpenPromise) return owner.folderOpenPromise;
  owner.folderOpen = true;
  owner.folderOpenPromise = window.yshare.openWriteFolder(owner.offer.tid, owner.offer.name)
    .then((base) => {
      if (!receiverIsCurrent(owner) || owner.cancelled) return base;
      owner.folderBasePath = base;
      return base;
    });
  owner.folderOpenPromise.catch((err) => failReceive(owner, err, 'could not create the destination folder'));
  return owner.folderOpenPromise;
}

function sameFolderMeta(a, b, rawRelPath) {
  return a.relPath === b.relPath && a.rawRelPath === rawRelPath && a.size === b.size && a.hash === b.hash;
}

function wireReceiver(dc, connectionIndex, owner) {
  if (!receiverIsCurrent(owner) || owner.cancelled) {
    try { dc.close(); } catch {}
    return;
  }
  dc.binaryType = 'arraybuffer';
  const st = {
    connectionIndex, mode: null, start: 0, end: 0, pos: 0,
    fileIdx: null, rangeComplete: false, writeQ: Promise.resolve(),
  };
  owner.chanState.set(dc, st);
  if (owner.channelIndexes.has(connectionIndex) || dc.label !== 'f' + connectionIndex) {
    failReceive(owner, 'unexpected or duplicate data channel');
    try { dc.close(); } catch {}
    return;
  }
  owner.channelIndexes.add(connectionIndex);
  if (connectionIndex === 0) {
    owner.ctrl = dc;
    // Tell the sender our listeners are wired. Metadata is still rejected until
    // the owner explicitly presses Accept.
    const sayReady = () => { try { dc.send(JSON.stringify({ type: 'ready' })); } catch {} };
    if (dc.readyState === 'open') sayReady();
    else dc.addEventListener('open', sayReady);
  }

  dc.onmessage = (e) => {
    if (R !== owner || owner.cancelled || owner.finished) return;
    if (typeof e.data === 'string') {
      let m;
      try { m = JSON.parse(e.data); }
      catch (err) { failReceive(owner, 'malformed control message'); return; }

      try {
        if (m.type === 'offer-file' || m.type === 'offer-folder') {
          if (connectionIndex !== 0 || owner.offer || owner.accepted) throw new Error('unexpected or duplicate transfer offer');
          const offer = m.type === 'offer-file' ? validateOfferFile(m) : validateOfferFolder(m);
          owner.offer = offer;
          owner.folder = offer.folder ? offer : null;
          if (owner.connectTimer) { clearTimeout(owner.connectTimer); owner.connectTimer = null; }
          $('incName').textContent = offer.name;
          $('incSize').textContent = offer.folder
            ? `Folder · ${offer.count} file${offer.count === 1 ? '' : 's'} · ${fmt(offer.totalSize)}`
            : fmt(offer.size);
          $('recvPassWrap').style.display = offer.locked ? '' : 'none';
          $('recvPass').value = '';
          $('incMsg').textContent = offer.locked
            ? `This ${offer.folder ? 'folder' : 'file'} is locked — enter the password the sender set.`
            : '';
          $('incomingCard').style.display = '';
          $('btnAccept').disabled = false;
          $('btnDecline').disabled = false;
          setStatus(`incoming ${offer.folder ? 'folder' : 'file'} — accept to start`, 'on');
          return;
        }

        if (m.type === 'file-meta') {
          if (!owner.accepted) throw new Error('folder metadata arrived before local acceptance');
          const meta = validateFolderMeta(m, owner.offer, connectionIndex);
          if (st.mode && !st.rangeComplete) throw new Error('a new range arrived before the prior range completed');
          let canonical = owner.fileMeta.get(meta.idx);
          if (canonical) {
            if (!sameFolderMeta(canonical, meta, m.relPath)) throw new Error('folder metadata changed between connections');
          } else {
            const pathKey = meta.relPath.toLowerCase();
            if (owner.folderPathOwners.has(pathKey)) throw new Error('two folder entries resolve to the same path');
            owner.folderDeclaredSize += meta.size;
            if (!Number.isSafeInteger(owner.folderDeclaredSize) || owner.folderDeclaredSize > owner.folder.totalSize) {
              throw new Error('folder file sizes exceeded the accepted total');
            }
            canonical = { ...meta, rawRelPath: m.relPath, seenConnections: new Set(), doneConnections: new Set(), error: null };
            owner.fileMeta.set(meta.idx, canonical);
            owner.folderPathOwners.set(pathKey, meta.idx);
            const folderReady = ensureFolderOpen(owner);
            const opening = folderReady.then(() => {
              if (!receiverIsCurrent(owner) || owner.cancelled) return null;
              return window.yshare.openWriteFile(owner.offer.tid, meta.idx, meta.relPath, meta.size);
            });
            opening.catch((err) => failReceive(owner, err, 'could not create a destination file'));
            owner.filesOpening.set(meta.idx, opening);
          }
          if (canonical.seenConnections.has(connectionIndex)) throw new Error('duplicate folder range metadata');
          canonical.seenConnections.add(connectionIndex);
          st.mode = 'folder'; st.fileIdx = meta.idx; st.start = meta.start; st.end = meta.end;
          st.pos = meta.start; st.rangeComplete = meta.start === meta.end;
          if (!owner.filesStarted.has(meta.idx)) {
            owner.filesStarted.add(meta.idx);
            setStatus(`receiving… file ${owner.filesStarted.size}/${owner.folder.count}`, 'on');
          }
          markReceiveStarted(owner);
          if (st.rangeComplete) {
            canonical.doneConnections.add(connectionIndex);
            maybeFinalizeFolderFile(owner, meta.idx);
          }
          return;
        }

        if (m.type === 'folder-sent') {
          if (connectionIndex !== 0 || !owner.accepted || !owner.offer || !owner.offer.folder) {
            throw new Error('folder completion arrived before local acceptance');
          }
          if (m.tid !== owner.offer.tid || m.count !== owner.offer.count || owner.folderSent) {
            throw new Error('folder completion did not match the accepted offer');
          }
          owner.folderSent = true;
          if (owner.offer.count === 0 && owner.offer.totalSize !== 0) throw new Error('empty folder declared a non-zero size');
          if (owner.fileMeta.size !== owner.offer.count || owner.folderDeclaredSize !== owner.offer.totalSize) {
            throw new Error('folder completion did not include the accepted file list and total');
          }
          ensureFolderOpen(owner).then(() => {
            if (receiverIsCurrent(owner) && !owner.cancelled) maybeFinalizeFolder(owner);
          }).catch(() => {});
          return;
        }

        if (m.type === 'deny') {
          if (connectionIndex !== 0 || !owner.offer || m.tid !== owner.offer.tid
            || !owner.accepted || owner.singleMeta || owner.fileMeta.size) {
            throw new Error('unexpected password response');
          }
          if (!Number.isSafeInteger(m.left) || m.left < 0 || m.left >= PASSWORD_ATTEMPTS) {
            throw new Error('invalid password-attempt count');
          }
          owner.accepted = false;
          owner.preparingAccept = false;
          if (m.left > 0) {
            $('incMsg').textContent = `Wrong password — ${m.left} attempt${m.left === 1 ? '' : 's'} left.`;
            $('btnAccept').disabled = false;
            $('btnDecline').disabled = false;
            setStatus('wrong password', 'err');
          } else {
            $('incomingCard').style.display = 'none';
            setStatus('wrong password 3 times — sender closed the transfer', 'err');
            showRecvResult(false, 'Wrong password entered 3 times — the sender closed the transfer.');
            owner.cancelled = true;
            owner.terminal = 'failed';
            setTimeout(() => receiverTeardown(owner), 200);
          }
          return;
        }

        if (m.type === 'cancel') {
          if (connectionIndex !== 0 || !owner.offer || m.tid !== owner.offer.tid) {
            throw new Error('cancel did not match the accepted transfer');
          }
          abortReceive(owner, false, 'sender cancelled ✗', 'The sender cancelled the transfer.');
          return;
        }

        if (m.type === 'meta') {
          if (!owner.accepted) throw new Error('file metadata arrived before local acceptance');
          const meta = validateFileMeta(m, owner.offer, connectionIndex);
          if (st.mode) throw new Error('duplicate file range metadata');
          if (owner.singleMeta && (owner.singleMeta.hash !== meta.hash || owner.singleMeta.size !== meta.size || owner.singleMeta.name !== meta.name)) {
            throw new Error('file metadata changed between connections');
          }
          if (!owner.singleMeta) {
            owner.singleMeta = meta;
            owner.size = meta.size; owner.hash = meta.hash; owner.received = 0;
            owner.openPromise = window.yshare.openWrite(owner.offer.tid, meta.name, meta.size);
            owner.openPromise.catch((err) => failReceive(owner, err, 'could not create the destination file'));
          }
          if (owner.singleMetaChannels.has(connectionIndex)) throw new Error('duplicate file range metadata');
          owner.singleMetaChannels.add(connectionIndex);
          st.mode = 'single'; st.start = meta.start; st.end = meta.end; st.pos = meta.start;
          st.rangeComplete = meta.start === meta.end;
          markReceiveStarted(owner);
          if (st.rangeComplete) owner.singleDoneChannels.add(connectionIndex);
          maybeFinalizeSingle(owner);
          return;
        }
      } catch (err) {
        failReceive(owner, err);
      }
      return;
    }

    if (!owner.accepted || !owner.offer || !st.mode) {
      failReceive(owner, 'binary data arrived before local acceptance and validated metadata');
      return;
    }
    const data = e.data;
    const length = data && Number.isSafeInteger(data.byteLength) ? data.byteLength : -1;
    if (length <= 0 || st.rangeComplete || st.pos + length > st.end) {
      failReceive(owner, 'a data chunk exceeded its declared byte range');
      return;
    }

    if (st.mode === 'folder') {
      const idx = st.fileIdx;
      const meta = owner.fileMeta.get(idx);
      const fileReceived = owner.fileReceived.get(idx) || 0;
      if (!meta || fileReceived + length > meta.size || owner.received + length > owner.folder.totalSize) {
        failReceive(owner, 'folder data exceeded its declared size');
        return;
      }
      const writeAt = st.pos;
      st.pos += length;
      owner.received += length;
      owner.fileReceived.set(idx, fileReceived + length);
      const prev = owner.fileWriteQ.get(idx) || owner.filesOpening.get(idx);
      const q = prev.then(() => {
        if (!receiverIsCurrent(owner) || owner.cancelled) return null;
        return window.yshare.writeFileChunk(owner.offer.tid, idx, writeAt, data);
      });
      q.catch((err) => failReceive(owner, err, 'disk write failed'));
      owner.fileWriteQ.set(idx, q);
      updateProgress('recv', owner.received, owner.folder.totalSize, owner.t0);
      if (st.pos === st.end) {
        st.rangeComplete = true;
        meta.doneConnections.add(connectionIndex);
        maybeFinalizeFolderFile(owner, idx);
      }
      return;
    }

    if (owner.received + length > owner.size) {
      failReceive(owner, 'file data exceeded its declared size');
      return;
    }
    const writeAt = st.pos;
    st.pos += length;
    owner.received += length;
    st.writeQ = st.writeQ
      .then(() => owner.openPromise)
      .then(() => (!receiverIsCurrent(owner) || owner.cancelled)
        ? null
        : window.yshare.writeChunkAt(owner.offer.tid, writeAt, data));
    st.writeQ.catch((err) => failReceive(owner, err, 'disk write failed'));
    updateProgress('recv', owner.received, owner.size, owner.t0);
    if (st.pos === st.end) {
      st.rangeComplete = true;
      owner.singleDoneChannels.add(connectionIndex);
      maybeFinalizeSingle(owner);
    }
  };
}

function maybeFinalizeSingle(owner) {
  if (!receiverIsCurrent(owner) || owner.cancelled || owner.finished || owner.finalizing || !owner.singleMeta) return;
  if (owner.singleMetaChannels.size !== NUM_CONNS || owner.singleDoneChannels.size !== NUM_CONNS) return;
  if (owner.received !== owner.size) {
    failReceive(owner, 'file byte count did not match its metadata');
    return;
  }
  owner.finalizePromise = finalizeReceive(owner);
}

// Wait for the file to be open + every connection's write queue to drain, then
// verify + finalize. Runs once per transfer.
async function finalizeReceive(owner) {
  if (!receiverIsCurrent(owner) || owner.finished || owner.cancelled || owner.finalizing) return;
  owner.finalizing = true;
  let res;
  try {
    await Promise.all([...owner.chanState.values()].map((s) => s.writeQ));
    if (!receiverIsCurrent(owner) || owner.cancelled) return;
    await owner.openPromise;
    if (!receiverIsCurrent(owner) || owner.cancelled) return;
    res = await window.yshare.finishWrite(owner.offer.tid, owner.hash);
    // finishWrite deliberately retains ownership until completeWrite. A Cancel
    // during hash/rename therefore wins and can still remove the verified file.
    if (!receiverIsCurrent(owner) || owner.cancelled) {
      await window.yshare.abortWrite(owner.offer.tid).catch(() => false);
      return;
    }
  } catch (err) {
    if (!receiverIsCurrent(owner) || owner.cancelled) {
      await window.yshare.abortWrite(owner.offer && owner.offer.tid).catch(() => false);
      return;
    }
    res = { ok: false, path: null, error: err && err.message ? err.message : 'disk write failed' };
  }
  let ok = !!(res && res.ok);
  let cleanupConfirmed = true;
  let reason = ok ? '' : (res && res.error ? res.error : 'integrity check failed');
  if (!ok) {
    owner.terminal = 'failed';
    cleanupConfirmed = await window.yshare.abortWrite(owner.offer.tid).catch(() => false);
  } else {
    // Hash + rename are done. Lock the terminal result, then release main's
    // ownership so future cleanup cannot delete this completed download.
    owner.terminal = 'completing';
    if (receiverIsCurrent(owner)) $('btnRecvCancel').style.display = 'none';
    try {
      await window.yshare.completeWrite(owner.offer.tid);
      owner.terminal = 'completed';
    } catch (err) {
      ok = false;
      owner.terminal = 'failed';
      reason = err && err.message ? err.message : 'could not commit the completed file';
      cleanupConfirmed = await window.yshare.abortWrite(owner.offer.tid).catch(() => false);
    }
  }
  if (!receiverIsCurrent(owner) || owner.cancelled) return;
  owner.finished = true;
  owner.finalizing = false;
  $('btnRecvCancel').style.display = 'none';
  const cleanupText = ok ? '' : await cleanupOutcomeText(cleanupConfirmed, 'file');
  if (!receiverIsCurrent(owner) || owner.cancelled) return;
  showRecvResult(ok, ok
    ? `Received & verified ✓ — saved to ${res.path}`
    : `The file could not be saved: ${reason}. ${cleanupText}`);
  setStatus(ok ? 'done ✓' : 'file receive failed', ok ? 'on' : 'err');
  sendReceiverAckOnce(owner, ok, ok ? undefined : 'file verification or save failed');
  setTimeout(() => receiverTeardown(owner), 500);
}

$('btnAccept').onclick = async () => {
  const owner = R;
  if (!receiverIsCurrent(owner) || !owner.offer || owner.preparingAccept || owner.accepted || owner.cancelled || owner.finished || owner.terminal) return;
  const msg = { type: 'accept', tid: owner.offer.tid };
  if (owner.offer.locked) {
    const pw = $('recvPass').value;
    if (!pw) { $('incMsg').textContent = 'Enter the password first.'; return; }
    msg.auth = passwordProof(owner.offer.tid, pw.trim());
  }
  owner.preparingAccept = true;
  $('btnAccept').disabled = true;
  $('btnDecline').disabled = true;
  $('incMsg').textContent = 'Preparing a safe destination…';
  try {
    await window.yshare.beginReceive(owner.offer.tid);
    if (!receiverIsCurrent(owner) || owner.cancelled || owner.finished || owner.terminal) return;
    // This is the only place local receive consent becomes true. Network metadata
    // can never flip this flag on the owner's behalf.
    owner.preparingAccept = false;
    owner.accepted = true;
    owner.received = 0;
    owner.t0 = 0;
    $('incMsg').textContent = owner.offer.locked ? 'Checking password…' : 'Accepted — waiting for the sender to start…';
    recvCtrlSend(msg, owner);
  } catch (err) {
    owner.preparingAccept = false;
    if (!receiverIsCurrent(owner) || owner.cancelled || owner.finished) return;
    $('btnAccept').disabled = false;
    $('btnDecline').disabled = false;
    $('incMsg').textContent = 'Could not prepare the save location — try Accept again.';
    setStatus('could not prepare the download', 'err');
  }
};

$('btnDecline').onclick = () => {
  const owner = R;
  if (!receiverIsCurrent(owner) || owner.preparingAccept || owner.accepted || owner.cancelled || owner.finished || owner.terminal) return;
  recvCtrlSend({ type: 'decline' }, owner);
  owner.cancelled = true;
  owner.terminal = 'declined';
  $('incomingCard').style.display = 'none';
  setStatus('declined', 'err');
  showRecvResult(false, 'You declined this transfer. Nothing was downloaded.');
  setTimeout(() => receiverTeardown(owner), 200);
};

$('btnRecvCancel').onclick = () => {
  const owner = R;
  if (!receiverIsCurrent(owner) || owner.finished || owner.terminal) return;
  abortReceive(owner, true, 'cancelled', 'Transfer cancelled.');
};

// --- quick connect (receiver): join the sender's room ------------------------
$('btnQuickJoin').onclick = async () => {
  const code = $('quickIn').value.trim().toUpperCase();
  if (code.length !== 6) { setStatus('enter the 6-character code', 'err'); return; }
  $('btnQuickJoin').disabled = true;
  const attempt = startReceiverQuickAttempt();
  // Wait for the first settings read, then judge the LIVE state: someone who just
  // saved a server must not have to restart the app before Quick Connect works.
  await runtimeReady;
  if (!canQuickConnect()) {
    if (!receiverQuickIsCurrent(attempt, null)) return;
    receiverQuickGate.retire(attempt);
    unlockManual('manualRecv');
    setStatus('quick connect needs a server — set one on the home screen, or use the manual code below', 'warn');
    return;
  }
  if (!receiverQuickIsCurrent(attempt, null)) return;
  setStatus('contacting connect server…', 'warn');
  let sig = null, quickTurn = null;
  try {
    sig = await signalDial();
  } catch (e) {
    if (!receiverQuickIsCurrent(attempt, null)) return;
    receiverQuickGate.retire(attempt);
    setStatus('quick connect unavailable — manual codes unlocked below', 'err');
    unlockManual('manualRecv');
    $('btnQuickJoin').disabled = !canQuickConnect();
    return;
  }
  if (!receiverQuickGate.bindSocket(attempt, sig)) {
    try { sig.close(); } catch {}
    return;
  }
  sig.onClose = () => {
    if (!receiverQuickIsCurrent(attempt, sig)) return;
    receiverQuickGate.retire(attempt);
    if (attempt.handshakeDone) return;
    if (attempt.owner) abandonReceiverAttempt(attempt.owner);
    setStatus('lost the connection to the code server — try the code again', 'err');
    $('btnQuickJoin').disabled = !canQuickConnect();
  };
  sig.onMessage = async (m) => {
    if (!receiverQuickIsCurrent(attempt, sig)) return;
    if (attempt.processing) {
      receiverQuickGate.retire(attempt);
      try { sig.close(); } catch {}
      if (attempt.owner) abandonReceiverAttempt(attempt.owner);
      setStatus('quick connect received overlapping server messages — try again', 'err');
      unlockManual('manualRecv');
      $('btnQuickJoin').disabled = !canQuickConnect();
      return;
    }
    attempt.processing = true;
    try {
      if (m.t === 'joined') {
        quickTurn = m.turn;
        setStatus('found the sender — waiting for connection details…', 'warn');
      } else if (m.t === 'msg' && m.data && m.data.kind === 'offers') {
        const reply = await answerOffers(decodeCode(m.data.code), buildRtcConfig(quickTurn), attempt);
        if (!receiverQuickIsCurrent(attempt, sig)) return;
        const owner = attempt.owner;
        if (!receiverIsCurrent(owner) || owner.cancelled) throw new Error('receive attempt was replaced');
        owner.sig = sig;
        sig.send({ t: 'msg', data: { kind: 'answers', code: reply } });
        attempt.handshakeDone = true;
        setStatus('connecting…', 'warn');
        $('btnQuickJoin').disabled = !canQuickConnect();
      } else if (m.t === 'gone') {
        if (!attempt.handshakeDone) throw new Error('room closed before the handshake completed');
        receiverQuickGate.retire(attempt);
        sig.close();   // handshake done (or room died) — the socket's job is over
      } else if (m.t === 'err') {
        receiverQuickGate.retire(attempt);
        if (attempt.owner) abandonReceiverAttempt(attempt.owner);
        setStatus(friendlyServerError(m.why), 'err');
        $('btnQuickJoin').disabled = !canQuickConnect();
      }
    } catch (e) {
      if (!receiverQuickIsCurrent(attempt, sig)) return;
      receiverQuickGate.retire(attempt);
      if (attempt.owner) abandonReceiverAttempt(attempt.owner);
      setStatus('quick connect failed — manual codes unlocked below', 'err');
      unlockManual('manualRecv');
      $('btnQuickJoin').disabled = !canQuickConnect();
    } finally {
      attempt.processing = false;
    }
  };
  if (!receiverQuickIsCurrent(attempt, sig)) return;
  sig.send({ t: 'join', code });
};

// --- manual fallback (receiver) -----------------------------------------------
$('btnCreateAnswer').onclick = async () => {
  const attempt = startReceiverQuickAttempt();
  $('btnCreateAnswer').disabled = true;   // guard against double-click while creating
  setStatus('creating reply…', 'warn');
  try {
    const offers = decodeCode($('offerIn').value);
    await runtimeReady;
    const serverReady = canQuickConnect();
    if (!receiverQuickIsCurrent(attempt, null)) return;
    // No configured server → direct/STUN-only, which needs no infrastructure.
    const turn = serverReady ? await fetchTurnCreds() : null;
    if (!receiverQuickIsCurrent(attempt, null)) return;
    const answer = await answerOffers(offers, buildRtcConfig(turn), attempt);
    if (!receiverQuickIsCurrent(attempt, null)) return;
    $('answerOut').value = answer;
    setStatus('reply created — send it back to the sender' + (turn ? '' : ' (direct connection only)'), 'warn');
    receiverQuickGate.retire(attempt);
  } catch (err) {
    if (!receiverQuickIsCurrent(attempt, null)) return;
    receiverQuickGate.retire(attempt);
    if (attempt.owner) abandonReceiverAttempt(attempt.owner);
    setStatus("that code doesn't look right — copy it again and paste the whole thing", 'err');
  } finally {
    $('btnCreateAnswer').disabled = false;
  }
};

$('btnCopyAnswer').onclick = () => navigator.clipboard.writeText($('answerOut').value);

// --- progress ---------------------------------------------------------------
// Repaint throttled to ~4x/sec — repainting on every 64K chunk (hundreds/sec)
// wastes CPU for nothing the eye can see. The final 100% always paints.
const lastPaint = { send: 0, recv: 0 };
function updateProgress(which, done, total, start) {
  const now = performance.now();
  if (done < total && now - lastPaint[which] < 250) return;
  lastPaint[which] = now;
  const pct = total ? (done / total) * 100 : 0;
  const el = (performance.now() - start) / 1000;
  const speed = el > 0 ? done / el : 0;
  const eta = speed > 0 && done < total ? fmtEta((total - done) / speed) : '';
  const bar = which === 'send' ? 'sendBar' : 'recvBar';
  const txt = which === 'send' ? 'sendProg' : 'recvProg';
  $(bar).style.width = pct.toFixed(1) + '%';
  $(txt).textContent =
    `${fmt(done)} / ${fmt(total)} · ${pct.toFixed(1)}% · ${fmt(speed)}/s${eta ? ' · ' + eta : ''}`;
}

// --- settings: save location ---------------------------------------------------
function showSaveDir(p) { $('saveDirText').textContent = p; }
window.yshare.getDownloadDir().then(showSaveDir).catch(() => {});

$('btnChangeDir').onclick = async () => {
  const p = await window.yshare.pickDownloadDir();
  if (p) showSaveDir(p);           // null = user cancelled the dialog
};

$('btnResetDir').onclick = async () => {
  showSaveDir(await window.yshare.resetDownloadDir());
};

// --- settings: quick connect server --------------------------------------------
// YShare ships with no server address. This is the only place one can be set, and
// main validates every value before it is stored or used.
function showServerSetting(state) {
  const ok = !!(state && state.ok);
  const shown = ok ? state.display : 'not set';
  $('srvSummary').innerHTML = 'Quick connect server · <b></b>';
  $('srvSummary').querySelector('b').textContent = shown;
  if (state && typeof state.value === 'string') $('serverIn').value = state.value;
}

function setServerMsg(text, cls) {
  $('srvMsg').textContent = text || '';
  $('srvMsg').className = 'srv-msg' + (cls ? ' ' + cls : '');
}

$('btnServerToggle').onclick = () => {
  const open = $('serverBox').classList.toggle('open');
  $('btnServerToggle').textContent = open ? 'Close' : 'Change';
  if (open) $('serverIn').focus();
};

$('btnSaveServer').onclick = async () => {
  const state = await window.yshare.setSignalEndpoint($('serverIn').value).catch(() => null);
  if (!state) { setServerMsg('could not save that — try again', 'err'); return; }
  applySignalState(state);
  if (state.ok) setServerMsg('saved — quick connect is ready', 'ok');
  else setServerMsg(state.reason || 'that address cannot be used', 'err');
};

$('btnClearServer').onclick = async () => {
  const state = await window.yshare.clearSignalEndpoint().catch(() => null);
  applySignalState(state);
  $('serverIn').value = '';
  setServerMsg('removed — manual codes still work with no server at all');
};

// --- footer version -----------------------------------------------------------
window.yshare.getVersion().then((v) => { $('ver').textContent = 'v' + v; }).catch(() => {});

// --- COURIER skin presentation (additive; no transfer logic) -------------------
// The behavior code above writes the raw quick code into the (hidden)
// #quickCodeOut and toggles #incomingCard — these observers mirror that state
// into the claim-ticket tiles and the dashed placeholders, so the skin can
// change without touching a line of the transfer flow.
(() => {
  const mirrorTicket = () => {
    const code = $('quickCodeOut').textContent.trim();
    $('ticketTiles').replaceChildren(...[...code].map((ch) => {
      const s = document.createElement('span'); s.textContent = ch; return s;
    }));
    $('ticketCard').style.display = code ? '' : 'none';
    $('noTicket').style.display = code ? 'none' : '';
    $('issuedChip').style.display = code ? '' : 'none';
    $('btnQuickSend').style.display = code ? 'none' : '';
  };
  new MutationObserver(mirrorTicket)
    .observe($('quickCodeOut'), { childList: true, characterData: true, subtree: true });
  mirrorTicket();

  const mirrorParcel = () => {
    const hidden = $('incomingCard').style.display === 'none';
    $('noParcel').style.display = hidden ? '' : 'none';
  };
  new MutationObserver(mirrorParcel)
    .observe($('incomingCard'), { attributes: true, attributeFilter: ['style'] });
  mirrorParcel();
})();
