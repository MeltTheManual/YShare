'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { waitDrain, flush, createTerminalAcker, createAttemptGate } = require('../src/renderer/lifecycle');
const { isExpectedRendererUrl, isTrustedRendererEvent } = require('../src/main-security');

class FakeDataChannel extends EventTarget {
  constructor(bufferedAmount) {
    super();
    this.bufferedAmount = bufferedAmount;
    this.bufferedAmountLowThreshold = 256;
    this.readyState = 'open';
  }

  close() {
    this.readyState = 'closed';
    this.dispatchEvent(new Event('close'));
  }
}

test('data-channel drain waits settle on progress and reject on disconnect', async () => {
  const draining = new FakeDataChannel(1024);
  const drained = waitDrain(draining);
  draining.bufferedAmount = 128;
  draining.dispatchEvent(new Event('bufferedamountlow'));
  await drained;

  const closing = new FakeDataChannel(1024);
  const closed = flush(closing);
  closing.close();
  await assert.rejects(closed, /closed before queued data drained/i);
});

test('terminal acknowledgement helper sends exactly once', () => {
  const sent = [];
  const ack = createTerminalAcker((message) => sent.push(message));
  assert.equal(ack({ type: 'ack', ok: false }), true);
  assert.equal(ack({ type: 'ack', ok: true }), false);
  assert.deepEqual(sent, [{ type: 'ack', ok: false }]);
});

test('attempt gate rejects stale tokens and stale sockets', () => {
  const gate = createAttemptGate();
  const socket1 = {};
  const first = gate.start();
  assert.equal(gate.bindSocket(first, socket1), true);
  assert.equal(gate.isCurrent(first, socket1), true);

  let retired = null;
  const second = gate.start((previous) => { retired = previous; });
  assert.equal(retired, first);
  assert.equal(gate.isCurrent(first, socket1), false);
  assert.equal(gate.bindSocket(first, {}), false);

  const socket2 = {};
  assert.equal(gate.bindSocket(second, socket2), true);
  assert.equal(gate.isCurrent(second, socket1), false);
  assert.equal(gate.isCurrent(second, socket2), true);
  assert.equal(gate.retire(second), true);
  assert.equal(gate.isCurrent(second, socket2), false);
});

test('privileged IPC accepts only the expected local main frame', () => {
  const expected = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html')).href;
  const mainFrame = { url: expected };
  const contents = { mainFrame };
  const valid = { sender: contents, senderFrame: mainFrame };

  assert.equal(isExpectedRendererUrl(expected, expected), true);
  assert.equal(isExpectedRendererUrl(expected + '.evil', expected), false);
  assert.equal(isExpectedRendererUrl('https://example.com/index.html', expected), false);
  assert.equal(isTrustedRendererEvent(valid, contents, expected), true);
  assert.equal(isTrustedRendererEvent({ sender: contents, senderFrame: null }, contents, expected), false);
  assert.equal(isTrustedRendererEvent({ sender: contents, senderFrame: { url: expected } }, contents, expected), false,
    'a same-URL subframe is not the trusted main frame');
  assert.equal(isTrustedRendererEvent(valid, { mainFrame }, expected), false,
    'a different WebContents cannot borrow the trusted URL');
});

test('no signaling server address is compiled into the shipped app', () => {
  // The public launch promise: YShare runs no infrastructure, so no build may
  // carry a default address that would send strangers' traffic to one box.
  const shipped = [
    ['shared/engine.js', fs.readFileSync(path.join(__dirname, '..', 'shared', 'engine.js'), 'utf8')],
    ['src/renderer/renderer.js', fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8')],
    ['src/renderer/index.html', fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8')],
    ['src/main.js', fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')],
    ['mobile/App.tsx', fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8')],
  ];
  // A bare IPv4 literal, or any ws/wss URL pointing somewhere other than this machine.
  const ipLiteral = /\b(?!0\.0\.0\.0|127\.0\.0\.1|10\.0\.2\.2)((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)\b/;
  // Loopback forms are local, not a baked-in server, so they are allowed here.
  const remoteSocketUrl = /wss?:\/\/(?!localhost|127\.0\.0\.1|\[::1\]|your-server|example)[A-Za-z0-9.[]/;
  for (const [name, source] of shipped) {
    assert.doesNotMatch(source, ipLiteral, `${name} must not hardcode a server IP address`);
    assert.doesNotMatch(source, remoteSocketUrl, `${name} must not hardcode a signaling URL`);
  }
});

test('quick connect stays closed until a server is configured, on both entry points', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

  assert.match(preload, /getSignalEndpoint: \(\) => ipcRenderer\.invoke\('get-signal-endpoint'\)/);
  assert.match(main, /trustedHandle\('set-signal-endpoint'/,
    'the endpoint must be validated in main before it is stored');
  assert.match(main, /if \(!state\.ok\) return state;\s*\/\/ nothing is stored until it is valid/,
    'an address that fails validation must never reach settings.json');
  assert.match(renderer, /quickConnectReady = false;/,
    'the renderer must start closed so a failed settings read cannot open quick connect');
  assert.equal((renderer.match(/await runtimeReady;/g) || []).length, 4,
    'every quick path must wait for the first settings read before judging');
  // The gate reads LIVE state, never the value runtimeReady resolved to at startup.
  // Regression: saving a server used to require an app restart before it worked.
  assert.equal((renderer.match(/if \(!canQuickConnect\(\)\) \{/g) || []).length, 2,
    'both Quick Connect entry points must check the current setting, not the startup snapshot');
  assert.equal((renderer.match(/const serverReady = canQuickConnect\(\);/g) || []).length, 2,
    'both manual paths must decide on relay credentials from the current setting');
  assert.doesNotMatch(renderer, /await runtimeReady\s*\?|\bif \(!await runtimeReady\)/,
    'the startup promise must not be used as the answer, only as a wait');
  assert.equal((renderer.match(/serverReady \? await fetchTurnCreds\(\) : null/g) || []).length, 2,
    'both manual paths must stay direct-only when no server is configured');
  assert.match(renderer, /completionAckAction\(\{/,
    'receiver ACK timing must use the tested shared completion gate');
  assert.match(renderer, /if \(action === 'queue'\) \{\s*owner\.pendingAck/,
    'a valid early ACK must wait until the local send drains');
  assert.match(renderer, /function markLocalSendComplete\(owner\)/,
    'local completion must consume a queued ACK');
  assert.match(main, /COPYFILE_EXCL/,
    'filesystems without hard links must still publish with exclusive creation');
  assert.doesNotMatch(main, /fs\.promises\.rename\(/,
    'verified files must never use a rename path that can replace a raced destination');
  assert.match(main, /receiveClaimIsCurrent\(owner, epoch\)/,
    'receive opens must recheck their owner after asynchronous disk work');
  assert.doesNotMatch(preload, /openRead: \(owner, filePath\)/,
    'absolute source paths must stay in main instead of crossing the preload bridge');
  assert.match(preload, /beginFileSend: \(owner\)/,
    'the selected source must be snapshotted to a transfer owner');
  assert.match(preload, /scanFolder: \(\) => ipcRenderer\.invoke\('scan-folder'\)/,
    'the selected folder path must stay in main instead of crossing the bridge');
  assert.match(main, /trustedHandle\('scan-folder', async \(\) =>/,
    'folder scans must consume only the main-side picker result');
});

test('desktop release guards cover stale callbacks, destination reservations, and IPC navigation', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');

  assert.match(main, /webContents\.on\('will-navigate', blockUnexpectedNavigation\)/);
  assert.match(main, /webContents\.on\('will-frame-navigate', blockUnexpectedNavigation\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
  assert.match(main, /isTrustedRendererEvent\(event, trustedWebContents, rendererEntryUrl\)/);
  // Derived, not a magic number: every channel the preload can invoke must have a
  // handler registered through the trusted wrapper, and nothing may register twice.
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const invoked = [...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const handled = [...main.matchAll(/trustedHandle\('([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(handled).size, handled.length, 'no IPC channel may be registered twice');
  const unguarded = invoked.filter((channel) => !handled.includes(channel));
  assert.deepEqual(unguarded, [], 'every preload channel must cross the trusted main-frame wrapper');
  assert.equal((main.match(/ipcMain\.handle\(/g) || []).length, 1,
    'ipcMain.handle may appear only inside the trustedHandle wrapper');

  assert.match(main, /singleReceive = session;[\s\S]*createdByThisCall = true;/,
    'single-file destination ownership must be reserved before the open settles');
  assert.match(main, /!session\.createdByThisCall \|\| await unlinkWithRetry\(session\.partPath\)/,
    'a failed single open may delete only a file it created');
  assert.match(main, /session\.files\.set\(checkedIdx, file\);\s*session\.paths\.add\(pathKey\);[\s\S]*await fs\.promises\.mkdir/,
    'folder index and canonical path aliases must be reserved before awaits');
  assert.match(main, /!file\.createdByThisCall \|\| await unlinkWithRetry\(partPath\)/,
    'a failed folder-file open may delete only its own artifact');

  assert.match(renderer, /const senderQuickGate = createAttemptGate\(\)/);
  assert.match(renderer, /const receiverQuickGate = createAttemptGate\(\)/);
  assert.match(renderer, /\$\('btnCreateOffer'\)\.onclick = async \(\) => \{\s*const attempt = startSenderQuickAttempt\(\);/,
    'manual sender creation must invalidate Quick Connect before its first await');
  assert.match(renderer, /\$\('btnCreateAnswer'\)\.onclick = async \(\) => \{\s*const attempt = startReceiverQuickAttempt\(\);/,
    'manual receiver creation must invalidate Quick Connect before its first await');
  assert.match(renderer, /reloadInProgress = true;\s*retireSenderQuickAttempt\(\);\s*retireReceiverQuickAttempt\(\);/,
    'Home/reload cleanup must retire both signaling sockets before awaiting cleanup');
  assert.doesNotMatch(renderer.slice(renderer.indexOf('// --- quick connect (sender)'), renderer.indexOf('// --- serverless fallback (sender)')),
    /abandonSenderAttempt\(S\)|const owner = S/,
    'Quick sender callbacks must never act on the mutable global owner');
  assert.doesNotMatch(renderer.slice(renderer.indexOf('// --- quick connect (receiver)'), renderer.indexOf('// --- serverless fallback (receiver)')),
    /abandonReceiverAttempt\(R\)|const owner = R/,
    'Quick receiver callbacks must never act on the mutable global owner');
  assert.doesNotMatch(renderer, /discarded/,
    'cleanup results must not claim deletion without checking the cleanup result');
  assert.match(renderer, /Cleanup could not be confirmed\. Close YShare and manually delete/);
});

test('serverless connection copy states the direct-network boundary on both platforms', () => {
  const desktopHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const desktopRenderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const selfHosting = fs.readFileSync(path.join(__dirname, '..', 'docs', 'SELF-HOSTING.md'), 'utf8');
  const combined = [desktopHtml, desktopRenderer, mobile, readme, selfHosting].join('\n');

  assert.doesNotMatch(combined, /no server at all|no server whatsoever/i);
  assert.match(desktopHtml, /serverless connection link/);
  assert.match(mobile, /serverless connection link/);
  assert.match(readme, /Without TURN, the devices still need a direct network path\./);
  assert.match(selfHosting, /direct\/STUN-only/);
});

test('connection links use validated OS handlers and a fragment-only HTTPS bridge', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'docs', 'connect', 'index.html'), 'utf8');

  assert.match(main, /app\.requestSingleInstanceLock\(\)/,
    'a clicked reply must reach the sender process that still owns its WebRTC offer');
  assert.match(main, /app\.on\('second-instance'/);
  assert.match(main, /app\.setAsDefaultProtocolClient\('yshare'/);
  assert.match(main, /engine\.parseConnectionLink\(value\)/,
    'main must validate an OS-supplied URL before sending it to the renderer');
  assert.match(preload, /ipcRenderer\.on\('connection-link', listener\)/);
  assert.match(renderer, /window\.yshare\.onConnectionLink\(importConnectionLink\)/);
  assert.match(manifest, /android:scheme="yshare" android:host="connect"/);
  assert.match(manifest, /android\.intent\.category\.BROWSABLE/);

  assert.match(bridge, /location\.hash\.slice\(1\)/,
    'the bridge must read the connector from the fragment, not a server-visible query');
  assert.match(bridge, /yshare:\/\/connect\/#/);
  assert.doesNotMatch(bridge, /fetch\(|XMLHttpRequest|WebSocket/,
    'the static bridge must not send the connector anywhere');
  assert.doesNotMatch(bridge, /location\.(search|pathname)/,
    'the connector route must stay in the URL fragment');

  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');
  assert.match(renderer, /\$\('offerIn'\)\.style\.display = 'none'/,
    'desktop must hide an imported offer connector');
  assert.match(renderer, /\$\('answerIn'\)\.style\.display = 'none'/,
    'desktop must hide an imported reply connector');
  assert.match(mobile, /replyImported \? \([\s\S]*Reply connection loaded/,
    'Android must show a short loaded state instead of rendering the imported reply connector');
  assert.match(mobile, /offerImported \? \([\s\S]*Sender connection loaded/,
    'Android must show a short loaded state instead of rendering the imported offer connector');
  assert.doesNotMatch(mobile, /placeholder="Paste the (?:reply|sender)[^"]*"[\s\S]{0,180}\bmultiline\b/,
    'manual link fields must remain one line instead of expanding to the connector length');
  assert.match(mobile, /mode === null[\s\S]{0,500}status !== 'idle'/,
    'Android must render connection-link errors on the landing screen');
});

test('human link sharing is not counted as network connection time', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');

  assert.match(renderer, /const CONNECT_TIMEOUT_MS = 60000/);
  assert.match(mobile, /const CONNECT_TIMEOUT_MS = 60000/);
  assert.match(renderer, /answerOffers\(decodeCode\(m\.data\.code\), buildRtcConfig\(quickTurn\), attempt, true\)/,
    'desktop Quick Connect must enable the receiver timeout');
  assert.match(renderer, /answerOffers\(offers, buildRtcConfig\(turn\), attempt\)/,
    'desktop serverless sharing must leave the receiver timeout disabled');
  assert.match(mobile, /answerOffers\(decodeCode\(m\.data\.code\), buildRtcConfig\(quickTurn\), true\)/,
    'Android Quick Connect must enable the receiver timeout');
  assert.match(mobile, /answerOffers\(offers, buildRtcConfig\(turn\)\)/,
    'Android serverless sharing must leave the receiver timeout disabled');
  assert.match(renderer, /if \(!owner\.connectTimeoutEnabled/);
  assert.match(mobile, /s === 'connecting' && connectTimeoutEnabled/);

  const desktopAnswer = renderer.slice(renderer.indexOf('async function answerOffers'), renderer.indexOf('function armReceiverConnectTimeout'));
  const mobileAnswer = mobile.slice(mobile.indexOf('async function answerOffers'), mobile.indexOf('// Serverless flow: open the sender link'));
  assert.doesNotMatch(desktopAnswer, /connectTimer = setTimeout/,
    'desktop must not time the human while the reply link is being shared');
  assert.doesNotMatch(mobileAnswer, /recvTimerRef\.current = setTimeout/,
    'Android must not time the human while the reply link is being shared');
});

test('sender cancellation drains queued file data before sending the reason', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');
  const desktopCancel = renderer.slice(renderer.indexOf('function senderTeardownAfterCancel'), renderer.indexOf('async function flushSenderCancelNotice'));
  const mobileCancel = mobile.slice(mobile.indexOf('async function cancelSend()'), mobile.indexOf('async function flushPendingCancel()'));

  assert.ok(desktopCancel && mobileCancel, 'both cancellation paths must be found');
  assert.match(desktopCancel, /await waitSenderBuffers\(owner, CANCEL_DRAIN_TIMEOUT_MS[\s\S]*?senderCtrlSend\(\{ type: 'cancel' \}/,
    'desktop must drain queued file bytes before its cancellation message');
  assert.match(mobileCancel, /await waitSendBuffers\(CANCEL_DRAIN_TIMEOUT_MS[\s\S]*?type: 'cancel'/,
    'Android must drain queued file bytes before its cancellation message');
});

test('leaving during a cancel still delivers the cancel notice', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');

  // The drain helpers must accept an early-stop predicate, or an exit path has
  // no way to skip the long file drain without also killing the notice.
  assert.match(renderer, /async function waitSenderBuffers\(owner, timeoutMs, channels = owner && owner\.dcs, stopEarly = null\)/,
    'desktop drain helper must accept an early-stop predicate');
  assert.match(mobile, /async function waitSendBuffers\(timeoutMs: number, channels = sendDcsRef\.current,\s*\n\s*stopEarly: \(\(\) => boolean\) \| null = null\)/,
    'Android drain helper must accept an early-stop predicate');
  assert.match(renderer, /&& !\(stopEarly && stopEarly\(\)\)/,
    'desktop drain loop must honour the early-stop predicate');
  assert.match(mobile, /&& !\(stopEarly && stopEarly\(\)\)/,
    'Android drain loop must honour the early-stop predicate');

  // The pending notice must be tracked so an exit can wait for it.
  assert.match(renderer, /owner\.cancelNotice = \(async \(\) => \{/,
    'desktop must keep the pending cancel notice on the sender owner');
  assert.match(mobile, /cancelNoticeRef\.current = notice;/,
    'Android must keep the pending cancel notice in a ref');
  assert.match(renderer, /waitSenderBuffers\(owner, CANCEL_DRAIN_TIMEOUT_MS, owner\.dcs, \(\) => owner\.cancelHurry\)/,
    'desktop file drain must be interruptible by an exit');
  assert.match(mobile, /waitSendBuffers\(CANCEL_DRAIN_TIMEOUT_MS, channels, \(\) => cancelHurryRef\.current\)/,
    'Android file drain must be interruptible by an exit');

  // Both exits must flush, and the wait after the notice is sent must stay capped.
  const desktopExit = renderer.slice(renderer.indexOf('async function cleanupAndReload'), renderer.indexOf("$('btnSendNew').onclick"));
  assert.match(desktopExit, /await flushSenderCancelNotice\(senderOwner\)/,
    'desktop Home and New transfer must flush a pending cancel notice before teardown');
  const mobileReset = mobile.slice(mobile.indexOf('async function resetAll()'), mobile.indexOf('cleanupSenderCache()', mobile.indexOf('async function resetAll()')));
  assert.match(mobileReset, /await flushPendingCancel\(\)/,
    'Android Home, Back, and New transfer must flush a pending cancel notice before teardown');
  assert.match(renderer, /await waitSenderBuffers\(owner, CANCEL_NOTICE_TIMEOUT_MS, \[owner\.ctrl\]\)/,
    'desktop must cap the wait for the notice itself');
  assert.match(mobile, /await waitSendBuffers\(CANCEL_NOTICE_TIMEOUT_MS, dc \? \[dc\] : \[\]\)/,
    'Android must cap the wait for the notice itself');

  // Android's hardware Back goes through the same guarded reset.
  assert.match(mobile, /if \(mode !== null\) \{ resetAll\(\); return true; \}/,
    'Android hardware Back must use the same guarded reset as the Home button');
});

test('cancelling a transfer asks for confirmation first', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'App.tsx'), 'utf8');

  const desktopSendCancel = renderer.slice(renderer.indexOf("$('btnSendCancel').onclick"), renderer.indexOf('async function waitSenderBuffers'));
  const desktopRecvCancel = renderer.slice(renderer.indexOf("$('btnRecvCancel').onclick"));
  assert.match(desktopSendCancel, /if \(!confirm\(CANCEL_CONFIRM_SEND\)\) return;/,
    'desktop sender cancel must confirm before stopping the transfer');
  assert.match(desktopRecvCancel, /if \(!confirm\(CANCEL_CONFIRM_RECV\)\) return;/,
    'desktop receiver cancel must confirm before stopping the transfer');

  assert.match(mobile, /function confirmCancelSend\(\)[\s\S]{0,320}Alert\.alert\('Cancel this transfer\?'[\s\S]{0,320}onPress: \(\) => \{ cancelSend\(\); \}/,
    'Android sender cancel must confirm before stopping the transfer');
  assert.match(mobile, /function confirmCancelReceive\(\)[\s\S]{0,320}Alert\.alert\('Cancel this transfer\?'[\s\S]{0,320}onPress: \(\) => \{ cancelReceive\(\); \}/,
    'Android receiver cancel must confirm before stopping the transfer');
  assert.match(mobile, /onPress=\{confirmCancelSend\}/,
    'the Android sender cancel button must go through the confirmation');
  assert.match(mobile, /onPress=\{confirmCancelReceive\}/,
    'the Android receiver cancel button must go through the confirmation');
  assert.doesNotMatch(mobile, /onPress=\{cancelSend\}|onPress=\{cancelReceive\}/,
    'no cancel button may bypass its confirmation');
});
