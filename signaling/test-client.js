// Self-contained signaling security/compatibility test.
// `npm test` starts isolated servers on ephemeral ports, exercises them, and
// always tears down the child processes and WebSocket clients.

'use strict';

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const WebSocket = require('ws');

const TEST_SECRET = 'test-only-turn-secret-32-bytes-minimum';
const activeChildren = new Set();
const activeSockets = new Set();
let passed = 0;

function ok(name) {
  passed++;
  console.log(`  PASS ${name}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testEnv(overrides = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: '0',
    TURN_SECRET: TEST_SECRET,
    TURN_HOST: '127.0.0.1',
    TURN_TTL_SECS: '120',
    YSHARE_ENABLE_TURN_HTTP: '1',
    YSHARE_CREATE_PER_MIN: '100',
    YSHARE_JOIN_PER_MIN: '100',
    YSHARE_MESSAGE_PER_MIN: '100',
    YSHARE_UNKNOWN_PER_MIN: '100',
    YSHARE_TURN_PER_MIN: '100',
    ...overrides,
  };
}

function spawnServer(overrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname,
      env: testEnv(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`server startup timed out${stderr ? `: ${stderr.trim()}` : ''}`));
    }, 5000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/yshare-signal ready port=(\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ child, host: `127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      activeChildren.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`server exited before ready (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function stopServer(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, delay(2500)]);
  if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
}

function connect(host, pathname = '/') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}${pathname}`);
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 3000);
    ws.once('open', () => {
      clearTimeout(timer);
      activeSockets.add(ws);
      ws.once('close', () => activeSockets.delete(ws));
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('WebSocket message timeout'));
    }, timeoutMs);
    function onMessage(raw) {
      clearTimeout(timer);
      ws.off('message', onMessage);
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    }
    ws.on('message', onMessage);
  });
}

async function sendAndReceive(ws, body) {
  const response = nextMessage(ws);
  ws.send(JSON.stringify(body));
  return response;
}

async function sendRawAndReceive(ws, raw) {
  const response = nextMessage(ws);
  ws.send(raw);
  return response;
}

async function expectError(ws, body, why) {
  const response = await sendAndReceive(ws, body);
  assert(response.t === 'err', `expected err, got ${response.t}`);
  assert(response.why === why, `expected "${why}", got "${response.why}"`);
  return response;
}

function validateTurn(grant, expectedScopePattern) {
  assert(grant && typeof grant === 'object', 'TURN grant missing');
  assert(Array.isArray(grant.urls) && grant.urls.length === 2, 'TURN urls incomplete');
  assert(grant.urls[0] === 'turn:127.0.0.1:3478', 'unexpected TURN UDP url');
  assert(grant.urls[1] === 'turn:127.0.0.1:3478?transport=tcp', 'unexpected TURN TCP url');
  const match = String(grant.username || '').match(/^(\d+):ys\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  assert(match, 'TURN username is not expiry:YShare-scope:nonce');
  assert(expectedScopePattern.test(match[2]), `unexpected TURN scope ${match[2]}`);
  const now = Math.floor(Date.now() / 1000);
  const expiry = Number(match[1]);
  assert(expiry >= now + 100 && expiry <= now + 125, 'TURN credential lifetime is not brief');
  const expected = crypto.createHmac('sha1', TEST_SECRET).update(grant.username).digest('base64');
  assert(grant.credential === expected, 'TURN credential HMAC is invalid');
}

async function expectRejectedUpgrade(host, pathname, statusCode) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}${pathname}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('unexpected upgrade did not finish'));
    }, 3000);
    ws.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      assert(response.statusCode === statusCode, `unexpected upgrade status ${response.statusCode}`);
      response.resume();
      resolve();
    });
    ws.once('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error('unknown WebSocket path was accepted'));
    });
    ws.once('error', () => {});
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket close timeout')), timeoutMs);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function exerciseServer(host) {
  const base = `http://${host}`;

  const health = await fetch(`${base}/health`);
  assert(health.status === 200, `health returned ${health.status}`);
  assert(health.headers.get('cache-control') === 'no-store', 'health response may be cached');
  assert((await health.json()).ok === true, 'health payload not ok');
  const head = await fetch(`${base}/health`, { method: 'HEAD' });
  assert(head.status === 200, `health HEAD returned ${head.status}`);
  const post = await fetch(`${base}/health`, { method: 'POST' });
  assert(post.status === 405 && post.headers.get('allow') === 'GET, HEAD', 'health accepted a wrong method');
  ok('health endpoint, no-store, and strict HTTP methods');

  await expectRejectedUpgrade(host, '/not-a-signal-path', 404);
  ok('unknown WebSocket paths rejected');

  const turn1Response = await fetch(`${base}/turn`);
  const turn1 = await turn1Response.json();
  assert(turn1Response.status === 200, `turn returned ${turn1Response.status}`);
  assert(turn1Response.headers.get('cache-control') === 'no-store', 'TURN response may be cached');
  validateTurn(turn1, /^manual$/);
  const turn2 = await (await fetch(`${base}/turn`)).json();
  validateTurn(turn2, /^manual$/);
  assert(turn1.username !== turn2.username, 'TURN usernames are not unique');
  ok('brief unique TURN credentials');

  const sender = await connect(host);
  const created = await sendAndReceive(sender, { t: 'create' });
  assert(created.t === 'created', `create returned ${created.t}`);
  assert(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(created.code), `bad room code ${created.code}`);
  validateTurn(created.turn, /^[a-f0-9]{8}$/);
  ok('room creation and scoped quick-code credential');

  const stranger = await connect(host);
  await expectError(stranger, { t: 'join', code: 'NOPE2Z' }, 'no such code');
  stranger.close();

  const receiver = await connect(host);
  const peerNotice = nextMessage(sender);
  const joinedPromise = nextMessage(receiver);
  receiver.send(JSON.stringify({ t: 'join', code: created.code.toLowerCase() }));
  const joined = await joinedPromise;
  assert(joined.t === 'joined', `join returned ${joined.t}`);
  validateTurn(joined.turn, /^[a-f0-9]{8}$/);
  assert((await peerNotice).t === 'peer', 'creator did not receive peer notice');
  ok('lowercase join accepted and creator notified');

  const offersCode = crypto.randomBytes(48_000).toString('base64');
  const atReceiver = nextMessage(receiver);
  sender.send(JSON.stringify({ t: 'msg', data: { kind: 'offers', code: offersCode } }));
  const firstRelay = await atReceiver;
  assert(firstRelay.t === 'msg' && firstRelay.data.code === offersCode, 'sender-to-receiver relay corrupted');

  const answersCode = crypto.randomBytes(48_000).toString('base64');
  const atSender = nextMessage(sender);
  receiver.send(JSON.stringify({ t: 'msg', data: { kind: 'answers', code: answersCode } }));
  const secondRelay = await atSender;
  assert(secondRelay.t === 'msg' && secondRelay.data.code === answersCode, 'receiver-to-sender relay corrupted');
  ok('strict offers/answers signaling relay integrity');

  const gone = nextMessage(receiver);
  sender.send(JSON.stringify({ t: 'done' }));
  const goneMessage = await gone;
  assert(goneMessage.t === 'gone' && goneMessage.why === 'done', 'room teardown did not notify peer');
  sender.close();
  receiver.close();
  ok('room teardown notifies the peer');
}

async function verifyRateLimits() {
  const instance = await spawnServer({
    YSHARE_CREATE_PER_MIN: '2',
    YSHARE_JOIN_PER_MIN: '3',
    YSHARE_MESSAGE_PER_MIN: '3',
    YSHARE_UNKNOWN_PER_MIN: '2',
    YSHARE_TURN_PER_MIN: '2',
  });
  try {
    const base = `http://${instance.host}`;
    assert((await fetch(`${base}/turn`)).status === 200, 'first TURN request failed');
    assert((await fetch(`${base}/turn`)).status === 200, 'second TURN request failed');
    assert((await fetch(`${base}/turn`)).status === 429, 'TURN request limit was not enforced');

    const sender = await connect(instance.host);
    const created = await sendAndReceive(sender, { t: 'create' });
    const receiver = await connect(instance.host);
    const peerNotice = nextMessage(sender);
    const joined = nextMessage(receiver);
    receiver.send(JSON.stringify({ t: 'join', code: created.code }));
    assert((await joined).t === 'joined', 'rate-test receiver did not join');
    assert((await peerNotice).t === 'peer', 'rate-test sender did not see its peer');

    for (let i = 1; i <= 3; i++) {
      const relayed = nextMessage(receiver);
      sender.send(JSON.stringify({ t: 'msg', data: { kind: 'offers', code: `rate-${i}` } }));
      assert((await relayed).data.code === `rate-${i}`, `allowed relay ${i} did not arrive`);
    }
    const senderClosed = waitForClose(sender);
    const receiverGone = nextMessage(receiver);
    await expectError(sender, { t: 'msg', data: { kind: 'offers', code: 'rate-4' } }, 'rate limited');
    assert((await receiverGone).t === 'gone', 'rate-limited peer teardown was not propagated');
    await senderClosed;
    receiver.close();

    const joinProbe1 = await connect(instance.host);
    await expectError(joinProbe1, { t: 'join', code: 'NOPE3Z' }, 'no such code');
    const joinProbe2 = await connect(instance.host);
    await expectError(joinProbe2, { t: 'join', code: 'NOPE4Z' }, 'no such code');
    const joinProbe3 = await connect(instance.host);
    await expectError(joinProbe3, { t: 'join', code: 'NOPE5Z' }, 'rate limited');
    joinProbe1.close();
    joinProbe2.close();
    joinProbe3.close();

    const unknown = await connect(instance.host);
    await expectError(unknown, { t: 'nonsense-1' }, 'unknown type');
    await expectError(unknown, { t: 'nonsense-2' }, 'unknown type');
    await expectError(unknown, { t: 'nonsense-3' }, 'rate limited');
    unknown.close();

    const creator2 = await connect(instance.host);
    assert((await sendAndReceive(creator2, { t: 'create' })).t === 'created', 'second create should be allowed');
    const creator3 = await connect(instance.host);
    await expectError(creator3, { t: 'create' }, 'rate limited');
    creator2.close();
    creator3.close();
    ok('TURN, create, join, relay, and unknown-message rate limits');
  } finally {
    await stopServer(instance.child);
  }
}

async function verifyProtocolResilience() {
  const instance = await spawnServer({ YSHARE_MAX_MSG_BYTES: '8192' });
  try {
    const sender = await connect(instance.host);
    const created = await sendAndReceive(sender, { t: 'create' });
    const receiver = await connect(instance.host);
    const peerNotice = nextMessage(sender);
    const joined = nextMessage(receiver);
    receiver.send(JSON.stringify({ t: 'join', code: created.code }));
    assert((await joined).t === 'joined', 'resilience receiver did not join');
    assert((await peerNotice).t === 'peer', 'resilience sender did not see its peer');

    const depth = 1500;
    const deeplyNested = `{"t":"msg","data":{"kind":"offers","code":${'['.repeat(depth)}0${']'.repeat(depth)}}}`;
    const nestedResponse = await sendRawAndReceive(sender, deeplyNested);
    assert(nestedResponse.t === 'err' && nestedResponse.why === 'invalid relay message', 'deeply nested relay was not rejected');
    await expectError(
      sender,
      { t: 'msg', data: { kind: 'offers', code: 'valid-shape', extra: true } },
      'invalid relay message',
    );

    const relayed = nextMessage(receiver);
    sender.send(JSON.stringify({ t: 'msg', data: { kind: 'offers', code: 'still-alive' } }));
    assert((await relayed).data.code === 'still-alive', 'valid relay failed after hostile schema inputs');

    const oversized = await connect(instance.host);
    const oversizedClosed = waitForClose(oversized);
    oversized.send('x'.repeat(20_000));
    await oversizedClosed;
    assert(instance.child.exitCode == null, 'oversized frame terminated the signaling process');

    const health = await fetch(`http://${instance.host}/health`);
    assert(health.status === 200 && (await health.json()).ok === true, 'server health failed after hostile frames');
    const survivor = await connect(instance.host);
    assert((await sendAndReceive(survivor, { t: 'create' })).t === 'created', 'new client failed after hostile frames');
    sender.close();
    receiver.close();
    survivor.close();
    ok('strict relay schema and oversized/deep-message process survival');
  } finally {
    await stopServer(instance.child);
  }
}

async function verifyConnectionCap() {
  const instance = await spawnServer({
    YSHARE_MAX_CONNECTIONS: '2',
    YSHARE_MAX_CONNECTIONS_PER_IP: '1',
  });
  try {
    const first = await connect(instance.host);
    await expectRejectedUpgrade(instance.host, '/', 429);
    const firstClosed = waitForClose(first);
    first.close();
    await firstClosed;
    await delay(50);
    const replacement = await connect(instance.host);
    assert((await sendAndReceive(replacement, { t: 'create' })).t === 'created', 'connection slot was not released');
    replacement.close();
    ok('per-IP connection cap and close-time slot release');
  } finally {
    await stopServer(instance.child);
  }
}

async function verifyTurnEndpointDefaultsOff() {
  const instance = await spawnServer({ YSHARE_ENABLE_TURN_HTTP: '0' });
  try {
    const response = await fetch(`http://${instance.host}/turn`);
    assert(response.status === 404, `default-disabled /turn returned ${response.status}`);
    assert(response.headers.get('cache-control') === 'no-store', 'disabled /turn response may be cached');
    const post = await fetch(`http://${instance.host}/turn`, { method: 'POST' });
    assert(post.status === 404, `disabled /turn leaked through method response ${post.status}`);
    ok('anonymous /turn endpoint disabled unless explicitly enabled');
  } finally {
    await stopServer(instance.child);
  }
}

async function expectServerStartupFailure(env, expectedPattern, timeoutMessage) {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeChildren.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const result = await Promise.race([
    once(child, 'exit').then(([code]) => ({ code })),
    delay(4000).then(() => ({ timeout: true })),
  ]);
  activeChildren.delete(child);
  if (result.timeout) {
    child.kill();
    throw new Error(timeoutMessage);
  }
  assert(result.code !== 0, 'production misconfiguration exited successfully');
  assert(expectedPattern.test(output), `production failure was unclear: ${output.trim()}`);
}

async function verifyProductionFailsClosed() {
  const missingTurnEnv = { ...process.env, NODE_ENV: 'production', PORT: '0' };
  delete missingTurnEnv.TURN_SECRET;
  delete missingTurnEnv.TURN_HOST;
  await expectServerStartupFailure(
    missingTurnEnv,
    /startup refused|are required/,
    'production server started without TURN configuration',
  );
  ok('production startup fails closed without TURN configuration');

  const missingProxyEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: '0',
    TURN_SECRET: TEST_SECRET,
    TURN_HOST: '127.0.0.1',
  };
  delete missingProxyEnv.YSHARE_TLS_PROXY;
  delete missingProxyEnv.YSHARE_TRUST_PROXY;
  await expectServerStartupFailure(
    missingProxyEnv,
    /loopback TLS proxy|trusted client-IP forwarding/,
    'production server started without its TLS proxy boundary',
  );
  ok('production startup fails closed without TLS/trusted-proxy flags');
}

async function verifyConfiguredProductionMode() {
  const instance = await spawnServer({
    NODE_ENV: 'production',
    YSHARE_ENABLE_TURN_HTTP: '0',
    YSHARE_TLS_PROXY: '1',
    YSHARE_TRUST_PROXY: '1',
  });
  try {
    const health = await fetch(`http://${instance.host}/health`);
    assert(health.status === 200, `configured production health returned ${health.status}`);
    const publicTurn = await fetch(`http://${instance.host}/turn`);
    assert(publicTurn.status === 404, 'production exposed the manual TURN endpoint');
    const sender = await connect(instance.host);
    const created = await sendAndReceive(sender, { t: 'create' });
    assert(created.t === 'created', 'configured production quick-code create failed');
    validateTurn(created.turn, /^[a-f0-9]{8}$/);
    sender.close();
    ok('configured production keeps quick-code TURN and public /turn off');
  } finally {
    await stopServer(instance.child);
  }
}

// Self-hosting without coturn: the service must run, say so, and mint nothing.
// A transfer then needs a direct path, which is the honest zero-infrastructure mode.
async function verifySignalingOnlyMode() {
  const noTurnEnv = { ...testEnv(), YSHARE_NO_TURN: '1' };
  delete noTurnEnv.TURN_SECRET;
  delete noTurnEnv.TURN_HOST;
  delete noTurnEnv.YSHARE_ENABLE_TURN_HTTP;

  const instance = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      cwd: __dirname, env: noTurnEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    activeChildren.add(child);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`signaling-only startup timed out: ${stderr}`)), 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/yshare-signal ready port=(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, host: `127.0.0.1:${match[1]}` });
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
  });

  try {
    const health = await fetch(`http://${instance.host}/health`);
    assert(health.status === 200, `signaling-only health returned ${health.status}`);
    const publicTurn = await fetch(`http://${instance.host}/turn`);
    assert(publicTurn.status === 404, 'signaling-only mode exposed a TURN endpoint');

    const sender = await connect(instance.host);
    const created = await sendAndReceive(sender, { t: 'create' });
    assert(created.t === 'created', 'signaling-only create failed');
    assert(created.turn === null, 'signaling-only mode handed out relay credentials');
    const receiver = await connect(instance.host);
    const joined = await sendAndReceive(receiver, { t: 'join', code: created.code });
    assert(joined.t === 'joined', 'signaling-only join failed');
    assert(joined.turn === null, 'signaling-only join handed out relay credentials');
    sender.close();
    receiver.close();
    ok('signaling-only mode brokers rooms and mints no relay credentials');
  } finally {
    await stopServer(instance.child);
  }

  // Half-configured deployments must still fail loudly rather than downgrade.
  await expectServerStartupFailure(
    { ...testEnv(), YSHARE_NO_TURN: '1' },
    /conflicts with a configured TURN/,
    'server accepted YSHARE_NO_TURN alongside TURN credentials',
  );
  const publicTurnEnv = { ...testEnv(), YSHARE_NO_TURN: '1', YSHARE_ENABLE_TURN_HTTP: '1' };
  delete publicTurnEnv.TURN_SECRET;
  delete publicTurnEnv.TURN_HOST;
  await expectServerStartupFailure(
    publicTurnEnv,
    /nothing to serve/,
    'server accepted a public TURN endpoint with no relay behind it',
  );
  ok('signaling-only mode refuses half-configured relay settings');
}

async function cleanup() {
  for (const ws of [...activeSockets]) {
    try { ws.terminate(); } catch {}
  }
  await Promise.all([...activeChildren].map((child) => stopServer(child)));
}

async function main() {
  let mainServer;
  try {
    mainServer = await spawnServer();
    await exerciseServer(mainServer.host);
    await stopServer(mainServer.child);
    mainServer = null;
    await verifyRateLimits();
    await verifyProtocolResilience();
    await verifyConnectionCap();
    await verifyTurnEndpointDefaultsOff();
    await verifyProductionFailsClosed();
    await verifyConfiguredProductionMode();
    await verifySignalingOnlyMode();
    console.log(`PASS - ${passed} checks`);
  } finally {
    if (mainServer) await stopServer(mainServer.child);
    await cleanup();
  }
}

main().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exitCode = 1;
});
