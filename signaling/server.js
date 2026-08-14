// YShare signaling server.
//
// This service only coordinates short-lived WebRTC rooms and, when configured,
// mints short-lived coturn REST credentials. File bytes never pass through it.
// Rooms and rate-limit counters are in memory and expire automatically.

// Required, unless you deliberately run without a relay:
//   TURN_SECRET  coturn static-auth-secret
//   TURN_HOST    public relay hostname or IP address
//
//   YSHARE_NO_TURN=1 starts the service with signaling only. It then mints no
//   credentials and every transfer must find a direct path, which covers most
//   home networks but fails behind carrier-grade NAT. This must be declared on
//   purpose: a missing TURN_SECRET is still a startup error, so a half-finished
//   deployment can never silently downgrade everyone to direct-only.
//
// Optional:
//   PORT                         default 8443 (0 chooses an ephemeral port)
//   TURN_PORT                    default 3478
//   TURN_TTL_SECS                default 7200 (2h), maximum 21600 (6h)
//   YSHARE_ENABLE_TURN_HTTP=1    expose GET /turn for explicit dev/test use
//   YSHARE_TLS_PROXY=1           required in production; proxy terminates TLS
//   YSHARE_TRUST_PROXY=1         required in production; trust proxy X-Real-IP
//   YSHARE_*_PER_MIN             rate-limit overrides used by tests/operations

// The quick-code flow receives credentials inside its WebSocket responses and
// remains compatible when the public /turn endpoint is disabled.

'use strict';

const http = require('http');
const crypto = require('crypto');
const net = require('net');
const { WebSocketServer, WebSocket } = require('ws');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_DEV_OR_TEST = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const TLS_PROXY = process.env.YSHARE_TLS_PROXY === '1';
const TRUST_PROXY = process.env.YSHARE_TRUST_PROXY === '1';
const PORT = envInt('PORT', 8443, 0, 65535);
const TURN_PORT = envInt('TURN_PORT', 3478, 1, 65535);
// Two hours is a substantial reduction from the old six-hour default without
// cutting off ordinary multi-gigabyte relay transfers mid-stream.
const TURN_TTL_SECS = envInt('TURN_TTL_SECS', 2 * 60 * 60, 60, 6 * 60 * 60);
const TURN_HTTP_REQUESTED = process.env.YSHARE_ENABLE_TURN_HTTP === '1';
const TURN_HTTP_ENABLED = TURN_HTTP_REQUESTED && IS_DEV_OR_TEST;

const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_HOST = process.env.TURN_HOST || '';
// Signaling-only mode is an explicit choice, never an accident.
const TURN_DISABLED = process.env.YSHARE_NO_TURN === '1';

if (TURN_DISABLED && (TURN_SECRET || TURN_HOST)) {
  throw new Error('Startup refused: YSHARE_NO_TURN=1 conflicts with a configured TURN_SECRET/TURN_HOST');
}
if (!TURN_DISABLED && IS_PRODUCTION && (!TURN_SECRET || !TURN_HOST)) {
  throw new Error('Production startup refused: TURN_SECRET and TURN_HOST are required (or set YSHARE_NO_TURN=1)');
}
if (IS_PRODUCTION && (!TLS_PROXY || !TRUST_PROXY)) {
  throw new Error('Production startup refused: a loopback TLS proxy and trusted client-IP forwarding are required');
}
if (!TURN_DISABLED && IS_PRODUCTION && TURN_SECRET.length < 32) {
  throw new Error('Production startup refused: TURN_SECRET must contain at least 32 characters');
}
if (!TURN_DISABLED && (!TURN_SECRET || !TURN_HOST)) {
  throw new Error('TURN_SECRET and TURN_HOST must both be configured (or set YSHARE_NO_TURN=1)');
}
if (TURN_HTTP_REQUESTED && !IS_DEV_OR_TEST) {
  throw new Error('YSHARE_ENABLE_TURN_HTTP is allowed only when NODE_ENV is development or test');
}
if (TURN_HTTP_REQUESTED && TURN_DISABLED) {
  throw new Error('YSHARE_ENABLE_TURN_HTTP has nothing to serve while YSHARE_NO_TURN=1');
}
if (!TURN_DISABLED && !isSafeTurnHost(TURN_HOST)) {
  throw new Error('TURN_HOST must be a hostname or IP address without a URL scheme or path');
}

const ROOM_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_ROOMS = envInt('YSHARE_MAX_ROOMS', 500, 1, 10_000);
const MAX_MSG_BYTES = envInt('YSHARE_MAX_MSG_BYTES', 128 * 1024, 1024, 1024 * 1024);
const MAX_SIGNAL_CODE_CHARS = Math.max(1, MAX_MSG_BYTES - 1024);
const MAX_CONNECTIONS = envInt('YSHARE_MAX_CONNECTIONS', 2000, 1, 20_000);
const MAX_CONNECTIONS_PER_IP = envInt('YSHARE_MAX_CONNECTIONS_PER_IP', 40, 1, 1000);
const BIND_HOST = process.env.YSHARE_BIND_HOST || (IS_PRODUCTION ? '127.0.0.1' : '0.0.0.0');
if (IS_PRODUCTION && BIND_HOST !== '127.0.0.1' && BIND_HOST !== '::1') {
  throw new Error('Production startup refused: YSHARE_BIND_HOST must be loopback behind the TLS proxy');
}
const LIMITS = Object.freeze({
  create: envInt('YSHARE_CREATE_PER_MIN', 10, 1, 10_000),
  join: envInt('YSHARE_JOIN_PER_MIN', 30, 1, 10_000),
  message: envInt('YSHARE_MESSAGE_PER_MIN', 120, 1, 100_000),
  unknown: envInt('YSHARE_UNKNOWN_PER_MIN', 20, 1, 10_000),
  turn: envInt('YSHARE_TURN_PER_MIN', 10, 1, 10_000),
});

// Codes omit characters commonly confused when read aloud.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const CODE_RE = new RegExp(`^[${ALPHABET}]{${CODE_LEN}}$`);

const rooms = new Map(); // code -> { a, b, born, turnScope }
const rateLogs = new Map(); // "action:remote-address" -> { start, count }
const openConnections = new Map(); // remote-address -> count

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw == null || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function isSafeTurnHost(host) {
  if (typeof host !== 'string' || host.length > 253 || /[\s/@?#]/.test(host)) return false;
  return /^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])$/.test(host);
}

function log(event, details = '') {
  // Never log room codes, TURN credentials, or full client addresses.
  console.log(new Date().toISOString(), event, details);
}

function remoteKey(req) {
  // Production binds to loopback, so only the local TLS proxy can supply this
  // header. The proxy must overwrite (not append) X-Real-IP.
  const direct = req.socket.remoteAddress || 'unknown';
  if (TRUST_PROXY && (direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1')) {
    const forwarded = req.headers['x-real-ip'];
    if (typeof forwarded === 'string' && net.isIP(forwarded)) return forwarded;
  }
  return direct;
}

function allow(action, key) {
  const now = Date.now();
  const mapKey = `${action}:${key}`;
  let entry = rateLogs.get(mapKey);
  if (!entry || now - entry.start >= RATE_WINDOW_MS) {
    entry = { start: now, count: 0 };
    rateLogs.set(mapKey, entry);
  }
  if (entry.count >= LIMITS[action]) return false;
  entry.count += 1;
  return true;
}

// coturn REST auth accepts "expiry:label" usernames. The brief expiry limits
// credential reuse, while a random YShare-scoped label makes each grant unique.
function mintTurn(scope = 'manual') {
  if (TURN_DISABLED) return null;   // signaling-only deployment: direct/STUN only
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SECS;
  const safeScope = String(scope).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12) || 'session';
  const nonce = crypto.randomBytes(5).toString('base64url');
  const username = `${expiry}:ys.${safeScope}.${nonce}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return {
    username,
    credential,
    urls: [
      `turn:${TURN_HOST}:${TURN_PORT}`,
      `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
    ],
  };
}

function newCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null;
}

function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch {
    try { ws.terminate(); } catch {}
    return false;
  }
}

function sendError(ws, why) {
  send(ws, { t: 'err', why });
}

function rejectAbuse(ws) {
  sendError(ws, 'rate limited');
  try { ws.close(1008, 'rate limited'); } catch { try { ws.terminate(); } catch {} }
}

function validRelayData(data) {
  return !!data && typeof data === 'object' && !Array.isArray(data)
    && Object.keys(data).length === 2
    && Object.hasOwn(data, 'kind')
    && Object.hasOwn(data, 'code')
    && (data.kind === 'offers' || data.kind === 'answers')
    && typeof data.code === 'string'
    && data.code.length > 0
    && data.code.length <= MAX_SIGNAL_CODE_CHARS;
}

function closeRoom(code, why) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  for (const ws of [room.a, room.b]) {
    if (!ws) continue;
    send(ws, { t: 'gone', why });
    ws.roomCode = null;
  }
}

function writeJson(req, res, statusCode, body, allowHeader) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if (allowHeader) res.setHeader('allow', allowHeader);
  if (req.method === 'HEAD') return res.end();
  res.setHeader('content-length', Buffer.byteLength(payload));
  res.end(payload);
}

function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  writeJson(req, res, 405, { ok: false, error: 'method not allowed' }, methods.join(', '));
  return false;
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    return writeJson(req, res, 400, { ok: false, error: 'bad request' });
  }

  if (pathname === '/health') {
    if (!methodAllowed(req, res, ['GET', 'HEAD'])) return;
    return writeJson(req, res, 200, { ok: true });
  }

  if (pathname === '/turn') {
    if (!TURN_HTTP_ENABLED) return writeJson(req, res, 404, { ok: false });
    if (!methodAllowed(req, res, ['GET'])) return;
    if (!allow('turn', remoteKey(req))) {
      return writeJson(req, res, 429, { ok: false, error: 'rate limited' });
    }
    return writeJson(req, res, 200, mintTurn('manual'));
  }

  return writeJson(req, res, 404, { ok: false });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG_BYTES });

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }
  if (req.method !== 'GET' || (pathname !== '/' && pathname !== '/signal')) {
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const key = remoteKey(req);
  if (wss.clients.size >= MAX_CONNECTIONS || (openConnections.get(key) || 0) >= MAX_CONNECTIONS_PER_IP) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const key = remoteKey(req);
  openConnections.set(key, (openConnections.get(key) || 0) + 1);
  ws.roomCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => {
    // Protocol/size errors belong to this socket, never the whole process.
    if (ws.roomCode) closeRoom(ws.roomCode, 'peer connection error');
    try { ws.terminate(); } catch {}
  });

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      if (!allow('unknown', key)) return rejectAbuse(ws);
      return sendError(ws, 'bad json');
    }

    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      if (!allow('unknown', key)) return rejectAbuse(ws);
      return sendError(ws, 'unknown type');
    }

    if (message.t === 'create') {
      if (!allow('create', key)) return rejectAbuse(ws);
      if (ws.roomCode) return sendError(ws, 'already in a room');
      if (rooms.size >= MAX_ROOMS) return sendError(ws, 'server full');
      const code = newCode();
      if (!code) return sendError(ws, 'server full');
      const turnScope = crypto.randomBytes(4).toString('hex');
      rooms.set(code, { a: ws, b: null, born: Date.now(), turnScope });
      ws.roomCode = code;
      log('room created', `active=${rooms.size}`);
      return send(ws, { t: 'created', code, turn: mintTurn(turnScope) });
    }

    if (message.t === 'join') {
      if (!allow('join', key)) return rejectAbuse(ws);
      if (ws.roomCode) return sendError(ws, 'already in a room');
      const code = String(message.code || '').trim().toUpperCase();
      if (!CODE_RE.test(code)) return sendError(ws, 'no such code');
      const room = rooms.get(code);
      if (!room) return sendError(ws, 'no such code');
      if (room.b) return sendError(ws, 'room is full');
      if (!room.a || room.a.readyState !== WebSocket.OPEN) {
        closeRoom(code, 'creator left');
        return sendError(ws, 'no such code');
      }
      room.b = ws;
      ws.roomCode = code;
      log('room joined', `active=${rooms.size}`);
      send(ws, { t: 'joined', turn: mintTurn(room.turnScope) });
      return send(room.a, { t: 'peer' });
    }

    if (message.t === 'msg') {
      if (!allow('message', key)) return rejectAbuse(ws);
      const room = rooms.get(ws.roomCode);
      if (!room) return sendError(ws, 'not in a room');
      const other = room.a === ws ? room.b : room.a;
      if (!other) return sendError(ws, 'peer not here yet');
      if (!validRelayData(message.data)) return sendError(ws, 'invalid relay message');
      return send(other, { t: 'msg', data: message.data });
    }

    if (message.t === 'done') {
      if (ws.roomCode) closeRoom(ws.roomCode, 'done');
      return;
    }

    if (!allow('unknown', key)) return rejectAbuse(ws);
    return sendError(ws, 'unknown type');
  });

  ws.on('close', () => {
    if (ws.roomCode) closeRoom(ws.roomCode, 'peer disconnected');
    const next = (openConnections.get(key) || 1) - 1;
    if (next <= 0) openConnections.delete(key);
    else openConnections.set(key, next);
  });
});

const sweepTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.born > ROOM_TTL_MS) closeRoom(code, 'expired');
  }
  for (const [key, entry] of rateLogs) {
    if (now - entry.start >= RATE_WINDOW_MS) rateLogs.delete(key);
  }
}, 60_000);
sweepTimer.unref();

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(sweepTimer);
  for (const code of [...rooms.keys()]) closeRoom(code, 'server shutting down');
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, BIND_HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  log('yshare-signal ready', `port=${actualPort} public-turn=${TURN_HTTP_ENABLED ? 'enabled' : 'disabled'}`);
});
