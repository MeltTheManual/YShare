// YShare — SHARED transfer engine. Single source of truth for BOTH apps:
//   desktop (Electron renderer) loads it as a plain <script> → globalThis.YShareEngine
//   mobile  (React Native / Metro) imports it as a CommonJS module
// Keep this file 100% platform-neutral: no DOM, no Node fs, no React Native APIs.
// Anything here changes for BOTH apps at once — that's the point.
//
// Connector codes (2026-07-04): now DEFLATE-compressed. Format:
//   "YS1." + base64( deflateRaw( JSON.stringify(array-of-N-session-descriptions) ) )
// ~5-10x smaller than the old plain-base64 codes (SDP text is highly repetitive).
// decodeCode() still accepts the old plain-base64 format for backward compatibility.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./vendor/pako.min.js')); // mobile (Metro)
  } else {
    root.YShareEngine = factory(root.pako);                    // desktop (script tag)
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (pako) {
  'use strict';

  // --- tuning (measured in test-harness/, 2026-06-26 — see CHANGELOG) ---------
  const NUM_CONNS = 8;                    // parallel peer connections (sweet spot ~8)
  const CHUNK = 64 * 1024;                // 64 KiB per data-channel message (64K beat 16K)
  const PER_CONN_HIGH = 1 * 1024 * 1024;  // pause a connection above 1 MiB buffered
  const LOW_THRESHOLD = 256 * 1024;       // resume once it drains below 256 KiB

  // Untrusted peers control protocol messages. These limits are deliberately far
  // above normal use, but keep malformed metadata from turning into disk, memory,
  // or connection-count abuse before a platform adapter can reject it.
  const PROTOCOL_LIMITS = Object.freeze({
    maxTransferBytes: 8 * 1024 * 1024 * 1024 * 1024, // 8 TiB practical v1 ceiling
    maxFolderFiles: 100000,
    maxNameChars: 1024,
    maxRelativePathChars: 4096,
    maxConnectorCodeChars: 1024 * 1024,
    maxSdpChars: 1024 * 1024,
    maxTransferIdChars: 128,
  });

  function protocolError(reason) {
    throw new Error('Invalid transfer metadata: ' + reason);
  }

  function checkedInt(value, label, max) {
    if (!Number.isSafeInteger(value) || value < 0 || value > max) {
      protocolError(label + ' is out of range');
    }
    return value;
  }

  function checkedTransferId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > PROTOCOL_LIMITS.maxTransferIdChars) {
      protocolError('bad transfer id');
    }
    return value;
  }

  // A peer filename is display data, never a filesystem path. This cross-platform
  // sanitizer is intentionally stricter than either Windows or Android alone.
  function safeFileName(value, fallback) {
    const raw = typeof value === 'string' ? value : '';
    if (!raw || raw.length > PROTOCOL_LIMITS.maxNameChars) protocolError('bad file name');
    let name = raw
      .replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/g, '')
      .trim();
    if (!name || name === '.' || name === '..') name = fallback || 'received.bin';
    const stem = name.split('.')[0];
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) name = '_' + name;
    if (name.length > 240) name = name.slice(0, 240).replace(/[. ]+$/g, '');
    return name || fallback || 'received.bin';
  }

  // Normalize a sender-supplied folder-relative path. Platform adapters still do
  // their own canonical containment check immediately before opening the file.
  function safeRelativePath(value) {
    if (typeof value !== 'string' || !value || value.length > PROTOCOL_LIMITS.maxRelativePathChars) {
      protocolError('bad relative path');
    }
    const normalized = value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      protocolError('absolute path rejected');
    }
    const parts = normalized.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      protocolError('unsafe path segment');
    }
    return parts.map((part) => safeFileName(part, 'item')).join('/');
  }

  function validHash(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  }

  function validateOfferFile(message) {
    if (!message || typeof message !== 'object') protocolError('file offer missing');
    const tid = checkedTransferId(message.tid);
    const rawName = typeof message.name === 'string' ? message.name : '';
    const name = safeFileName(rawName, 'received.bin');
    const size = checkedInt(message.size, 'file size', PROTOCOL_LIMITS.maxTransferBytes);
    return { tid, rawName, name, size, locked: !!message.locked, folder: false };
  }

  function validateOfferFolder(message) {
    if (!message || typeof message !== 'object') protocolError('folder offer missing');
    const tid = checkedTransferId(message.tid);
    const rawName = typeof message.name === 'string' ? message.name : '';
    const name = safeFileName(rawName, 'received-folder');
    const count = checkedInt(message.count, 'file count', PROTOCOL_LIMITS.maxFolderFiles);
    const totalSize = checkedInt(message.totalSize, 'folder size', PROTOCOL_LIMITS.maxTransferBytes);
    return { tid, rawName, name, size: totalSize, totalSize, count, locked: !!message.locked, folder: true };
  }

  function validateFileMeta(message, offer, connectionIndex) {
    if (!offer || offer.folder || !message || typeof message !== 'object') protocolError('unexpected file metadata');
    checkedInt(connectionIndex, 'connection index', NUM_CONNS - 1);
    if (message.tid !== offer.tid || message.name !== offer.rawName || message.size !== offer.size) {
      protocolError('file metadata changed after acceptance');
    }
    if (!validHash(message.hash)) protocolError('bad SHA-256');
    const expected = connRange(connectionIndex, offer.size, NUM_CONNS);
    if (message.start !== expected.start || message.end !== expected.end) protocolError('bad byte range');
    return { name: offer.name, size: offer.size, hash: message.hash.toLowerCase(), start: expected.start, end: expected.end };
  }

  function validateFolderMeta(message, offer, connectionIndex) {
    if (!offer || !offer.folder || !message || typeof message !== 'object') protocolError('unexpected folder metadata');
    checkedInt(connectionIndex, 'connection index', NUM_CONNS - 1);
    if (message.tid !== offer.tid) protocolError('folder metadata changed after acceptance');
    const idx = checkedInt(message.idx, 'file index', Math.max(0, offer.count - 1));
    if (offer.count === 0) protocolError('metadata for an empty folder');
    if (message.count != null && message.count !== offer.count) protocolError('folder count changed after acceptance');
    const size = checkedInt(message.size, 'file size', PROTOCOL_LIMITS.maxTransferBytes);
    if (size > offer.totalSize) protocolError('file exceeds accepted folder size');
    if (!validHash(message.hash)) protocolError('bad SHA-256');
    const relPath = safeRelativePath(message.relPath);
    const expected = connRange(connectionIndex, size, NUM_CONNS);
    if (message.start !== expected.start || message.end !== expected.end) protocolError('bad byte range');
    return { idx, relPath, size, hash: message.hash.toLowerCase(), start: expected.start, end: expected.end };
  }

  function validateDescriptionArray(value, expectedType) {
    if (!Array.isArray(value) || value.length !== NUM_CONNS) protocolError('expected exactly ' + NUM_CONNS + ' connection descriptions');
    return value.map((desc) => {
      if (!desc || typeof desc !== 'object' || typeof desc.sdp !== 'string' || desc.sdp.length > PROTOCOL_LIMITS.maxSdpChars) {
        protocolError('bad session description');
      }
      if ((desc.type !== 'offer' && desc.type !== 'answer') || (expectedType && desc.type !== expectedType)) {
        protocolError('wrong session description type');
      }
      return { type: desc.type, sdp: desc.sdp };
    });
  }

  // ── Quick Connect endpoint — deliberately NOT compiled into the app ────────
  // YShare ships with no server of its own, so nobody inherits somebody else's
  // bandwidth bill. Quick Connect (the 6-character claim code) needs a small
  // signaling service; manual connector codes need none at all, so the app is
  // fully usable with this left unset.
  //
  // The address is chosen per install and handed to the engine at startup by the
  // platform (desktop settings.json / Android app settings). See docs/SELF-HOSTING.md.
  //
  // Transport policy, identical on both platforms:
  //   • wss:// (TLS) is always allowed;
  //   • ws:// (cleartext) only to loopback, or in a development build.
  //     A packaged desktop build or an Android release never talks cleartext to a
  //     remote host — it fails closed and falls back to manual codes.
  const MAX_SIGNAL_ENDPOINT_CHARS = 255;
  const SIGNAL_ENDPOINT_RE =
    /^(?:(wss|ws|https|http):\/\/)?([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?$/;

  // Deliberately narrow: exactly the hosts the desktop Content-Security-Policy
  // whitelists for cleartext (see src/renderer/index.html). Accepting a wider
  // range here, such as the rest of the 127.x loopback block, would let an address save as
  // "ready" and then be blocked at dial time with no explanation.
  // IPv6 literals are deliberately absent: CSP's host-source grammar cannot
  // express a bracketed IPv6 address, so `ws://[::1]:*` is rejected by the
  // browser as an invalid source and silently ignored. Allowing it here would
  // let such an address save as "ready" and then never dial. `localhost` already
  // covers IPv6 loopback by name on any modern system.
  function isLoopbackHost(host) {
    const h = String(host || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1';
  }

  function isValidSignalHost(host) {
    if (host.charAt(0) === '[') return /^\[[0-9A-Fa-f:.]{2,45}\]$/.test(host);
    if (host.length > 253) return false;
    const labels = host.split('.');
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      if (!label || label.length > 63) return false;
      if (label.charAt(0) === '-' || label.charAt(label.length - 1) === '-') return false;
      if (!/^[A-Za-z0-9-]+$/.test(label)) return false;
    }
    return true;
  }

  // Turn a person-typed address into the exact URLs the app will use.
  // Anything malformed returns null — this never guesses on the user's behalf.
  // A bare "example.com:8443" is treated as SECURE (wss), never as cleartext.
  function parseSignalEndpoint(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > MAX_SIGNAL_ENDPOINT_CHARS) return null;
    const m = SIGNAL_ENDPOINT_RE.exec(raw);
    if (!m) return null;
    const scheme = (m[1] || 'wss').toLowerCase();
    const host = m[2];
    if (!isValidSignalHost(host)) return null;
    let port = 0;
    if (m[3]) {
      port = parseInt(m[3], 10);
      if (!(port >= 1 && port <= 65535)) return null;
    }
    const secure = scheme === 'wss' || scheme === 'https';
    const authority = host + (port ? ':' + port : '');
    return {
      host,
      port,
      secure,
      authority,
      ws: (secure ? 'wss://' : 'ws://') + authority,
      http: (secure ? 'https://' : 'http://') + authority,
      display: (secure ? 'wss://' : 'ws://') + authority,
    };
  }

  // Why an otherwise valid endpoint may not be used in this build.
  // Returns null when it is fine, or a short sentence a non-technical person can read.
  function signalEndpointIssue(endpoint, allowInsecure) {
    if (!endpoint) return 'no quick connect server is set';
    if (endpoint.secure || isLoopbackHost(endpoint.host)) return null;
    if (allowInsecure) return null;
    return 'this build only connects to a secure wss:// server';
  }

  let activeSignal = null;        // parsed endpoint currently in use, or null
  let allowInsecureSignal = false; // set by the platform: dev builds only

  // Called once at startup, and again whenever the person changes the setting.
  // Never throws: it reports back so the UI can explain the problem in plain words.
  function configureSignaling(value, options) {
    const opts = options || {};
    allowInsecureSignal = !!opts.allowInsecure;
    if (value === null || value === undefined || String(value).trim() === '') {
      activeSignal = null;
      return { ok: true, endpoint: null, reason: '' };
    }
    const parsed = parseSignalEndpoint(value);
    if (!parsed) {
      activeSignal = null;
      return {
        ok: false,
        endpoint: null,
        reason: 'that address does not look right — it should look like wss://example.com:8443',
      };
    }
    const issue = signalEndpointIssue(parsed, allowInsecureSignal);
    if (issue) {
      activeSignal = null;
      return { ok: false, endpoint: null, reason: issue };
    }
    activeSignal = parsed;
    return { ok: true, endpoint: parsed, reason: '' };
  }

  function signalEndpoint() { return activeSignal; }
  function signalingConfigured() { return !!activeSignal; }

  // STUN = free "what's my public address?" lookup → enables a DIRECT connection.
  // TURN = a relay, FALLBACK ONLY (CGNAT / symmetric NAT). YShare runs no relay:
  // credentials are minted by whichever signaling server the person configured
  // (coturn use-auth-secret). No creds → STUN-only, and the direct path still
  // works, which is the correct free behaviour.
  function buildRtcConfig(turn) {
    const iceServers = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    // The configured signaling server supplies these, so the shape is checked
    // before handing anything to the WebRTC stack. A string `urls` would pass a
    // bare truthiness test and reach the browser as a malformed ICE server.
    if (turn
      && typeof turn.username === 'string' && turn.username
      && typeof turn.credential === 'string' && turn.credential
      && Array.isArray(turn.urls) && turn.urls.length
      && turn.urls.every(function (u) { return typeof u === 'string' && /^turns?:/i.test(u); })) {
      iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
    }
    return { iceServers, iceTransportPolicy: 'all' }; // direct-first; relay last resort
  }

  // Backward-compatible default config: STUN-only (direct-first path).
  const RTC_CONFIG = buildRtcConfig(null);

  // Fetch ephemeral relay creds over HTTP — used by the MANUAL-code fallback flow
  // (the quick flow gets creds inside the room messages). Fails soft: null =
  // direct-only, which is the correct free-path behaviour with no server set.
  // ⚠️ No async/await anywhere in this file: Metro bundles it from OUTSIDE the
  // mobile project and can't inject Babel runtime helpers here — promises only.
  function fetchTurnCreds(timeoutMs) {
    return new Promise(function (resolve) {
      const endpoint = activeSignal;
      if (!endpoint) { resolve(null); return; }
      try {
        const ctl = new AbortController();
        const t = setTimeout(function () { ctl.abort(); }, timeoutMs || 2500);
        fetch(endpoint.http + '/turn', { signal: ctl.signal })
          .then(function (res) {
            clearTimeout(t);
            return res.ok ? res.json() : null;
          })
          .then(function (json) { resolve(json); })
          .catch(function () { clearTimeout(t); resolve(null); });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Minimal signaling client over the platform WebSocket (browser + RN + Node 21+).
  // Resolves once connected; messages arrive on api.onMessage.
  function signalDial(url) {
    return new Promise((resolve, reject) => {
      const target = url || (activeSignal && activeSignal.ws);
      if (!target) {
        reject(new Error('no quick connect server is set'));
        return;
      }
      let settled = false;
      const ws = new WebSocket(target);
      const api = {
        send(obj) { try { ws.send(JSON.stringify(obj)); } catch (e) {} },
        close() { try { ws.close(); } catch (e) {} },
        onMessage: null,
        onClose: null,
      };
      ws.onopen = () => { settled = true; resolve(api); };
      ws.onerror = () => { if (!settled) { settled = true; reject(new Error('signal server unreachable')); } };
      ws.onclose = () => { if (api.onClose) api.onClose(); };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
        if (api.onMessage) api.onMessage(m);
      };
    });
  }

  // --- base64 (pure JS — RN/Hermes has no binary atob/btoa) -------------------
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64REV = (() => {
    const r = new Int16Array(128).fill(-1);
    for (let i = 0; i < 64; i++) r[B64.charCodeAt(i)] = i;
    return r;
  })();

  function u8ToBase64(bytes) {
    let out = '';
    const len = bytes.length;
    let i = 0;
    for (; i + 3 <= len; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    const rem = len - i;
    if (rem === 1) {
      const n = bytes[i] << 16;
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==';
    } else if (rem === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=';
    }
    return out;
  }

  function base64ToU8(str) {
    if (typeof str !== 'string' || str.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(str)) {
      protocolError('bad base64 data');
    }
    let end = str.length;
    while (end > 0 && str[end - 1] === '=') end--;
    const outLen = Math.floor((end * 3) / 4);
    const out = new Uint8Array(outLen);
    let o = 0, acc = 0, bits = 0;
    for (let i = 0; i < end; i++) {
      const v = B64REV[str.charCodeAt(i)];
      if (v < 0) continue;
      acc = (acc << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (acc >> bits) & 0xff;
      }
    }
    return out;
  }

  // Decode base64 → ASCII string (legacy plain-base64 codes; SDP/JSON is ASCII).
  function base64ToAscii(str) {
    const u8 = base64ToU8(str);
    let s = '';
    for (let i = 0; i < u8.length; i += 8192) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    }
    return s;
  }

  // --- connector codes ---------------------------------------------------------
  const CODE_PREFIX = 'YS1.';

  // Array of N session descriptions → compact shareable code.
  function encodeDescs(descs) {
    const checked = validateDescriptionArray(descs);
    const deflated = pako.deflateRaw(JSON.stringify(checked));
    return CODE_PREFIX + u8ToBase64(deflated);
  }

  function inflateConnectorJson(bytes) {
    const limit = PROTOCOL_LIMITS.maxSdpChars * NUM_CONNS;
    const chunks = [];
    let length = 0;
    let overflow = false;
    const inflator = new pako.Inflate({ raw: true, to: 'string' });
    inflator.onData = function (chunk) {
      length += chunk.length;
      if (length > limit) {
        overflow = true;
        throw new Error('connector expansion limit');
      }
      chunks.push(chunk);
    };
    try {
      inflator.push(bytes, true);
    } catch (error) {
      if (overflow) protocolError('connector code expands too large');
      throw error;
    }
    if (overflow) protocolError('connector code expands too large');
    if (inflator.err) protocolError(inflator.msg || 'connector code could not be decompressed');
    return chunks.join('');
  }

  // Shareable code → array of session descriptions. Strips whitespace (codes get
  // line-wrapped by chat apps). Accepts both the new compressed format and the
  // legacy plain-base64 format (pre-2026-07-04 builds).
  function decodeCode(code) {
    const clean = String(code).replace(/\s+/g, '');
    if (!clean || clean.length > PROTOCOL_LIMITS.maxConnectorCodeChars) protocolError('connector code is too large');
    let parsed;
    if (clean.startsWith(CODE_PREFIX)) {
      const json = inflateConnectorJson(base64ToU8(clean.slice(CODE_PREFIX.length)));
      parsed = JSON.parse(json);
    } else {
      parsed = JSON.parse(base64ToAscii(clean)); // legacy encoding, current N-connection shape
    }
    return validateDescriptionArray(parsed);
  }

  // --- password gate helpers (Stage 3) -----------------------------------------
  // The receiver never sends the password itself: it sends sha256Hex(tid + ':' + pw)
  // and the sender compares against its own computation — bound to THIS transfer id,
  // so a captured hash is useless for any other transfer.
  //
  // Pure-JS synchronous SHA-256: desktop's crypto.subtle is async-only and RN/Hermes
  // has no WebCrypto at all, so a tiny portable implementation is the one that works
  // everywhere (strings here are tiny — a code + a password — speed is irrelevant).
  const SHA_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.codePointAt(i);
      if (c > 0xffff) i++; // surrogate pair consumed
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256Hex(str) {
    const bytes = utf8Bytes(str);
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // 64-bit big-endian length (JS numbers are exact up to 2^53 — plenty here)
    const hi = Math.floor(bitLen / 0x100000000);
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255);
    bytes.push((bitLen >>> 24) & 255, (bitLen >>> 16) & 255, (bitLen >>> 8) & 255, bitLen & 255);

    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Int32Array(64);
    const rr = (x, n) => (x >>> n) | (x << (32 - n));

    for (let p = 0; p < bytes.length; p += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = (bytes[p + 4 * i] << 24) | (bytes[p + 4 * i + 1] << 16) | (bytes[p + 4 * i + 2] << 8) | bytes[p + 4 * i + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA_K[i] + w[i]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7]
      .map((x) => (x >>> 0).toString(16).padStart(8, '0'))
      .join('');
  }

  // sha256Hex(tid + ':' + password) — the value the receiver sends as proof.
  function passwordProof(tid, password) {
    return sha256Hex(tid + ':' + password);
  }

  // Random transfer id. crypto.getRandomValues exists in Chromium; RN/Hermes may
  // lack it — Math.random is fine there (the id scopes a password check, it is not
  // itself a secret: the password never travels, only its tid-bound hash).
  function newTransferId() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    let out = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      for (let i = 0; i < 16; i++) out += alphabet[buf[i] % alphabet.length];
    } else {
      for (let i = 0; i < 16; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  // --- connection helpers --------------------------------------------------------
  // Byte range for connection i of n over a size-byte file (contiguous split).
  function connRange(i, size, n) {
    return {
      start: Math.floor((i * size) / n),
      end: Math.floor(((i + 1) * size) / n),
    };
  }

  // Resolve when ICE gathering completes (or after timeout — don't hang on a stall).
  function waitIceComplete(pc, timeout) {
    if (timeout == null) timeout = 6000;
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
      pc.addEventListener('icegatheringstatechange', check);
      setTimeout(finish, timeout);
    });
  }

  return {
    NUM_CONNS,
    CHUNK,
    PER_CONN_HIGH,
    LOW_THRESHOLD,
    PROTOCOL_LIMITS,
    RTC_CONFIG,
    MAX_SIGNAL_ENDPOINT_CHARS,
    parseSignalEndpoint,
    signalEndpointIssue,
    configureSignaling,
    signalEndpoint,
    signalingConfigured,
    isLoopbackHost,
    buildRtcConfig,
    fetchTurnCreds,
    signalDial,
    u8ToBase64,
    base64ToU8,
    encodeDescs,
    decodeCode,
    connRange,
    safeFileName,
    safeRelativePath,
    validHash,
    validateOfferFile,
    validateOfferFolder,
    validateFileMeta,
    validateFolderMeta,
    validateDescriptionArray,
    waitIceComplete,
    sha256Hex,
    passwordProof,
    newTransferId,
  };
});
