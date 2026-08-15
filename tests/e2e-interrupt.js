// Proves the "removing the server kills the live claim code" fix.
// Before the fix: the code stayed on screen, the socket stayed open, and the room
// was still joinable through the server the user had just removed.
'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..');   // works from any clone
const WS = require(path.join(REPO, 'signaling', 'node_modules', 'ws'));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'yshare-e2e-'));
const APP = path.join(REPO, 'dist', 'win-unpacked', 'YShare.exe');
const PORT = 8455;
const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (n, v) => console.log('  ' + String(n).padEnd(36), v);
const fail = (m) => { throw new Error(m); };

function startSignaling() {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['server.js'], {
      cwd: path.join(REPO, 'signaling'),
      env: { ...process.env, NODE_ENV: 'development', YSHARE_NO_TURN: '1', PORT: String(PORT), TURN_SECRET: '', TURN_HOST: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(c);
    let o = '';
    const t = setTimeout(() => reject(new Error('signaling did not start')), 8000);
    c.stdout.on('data', (d) => { o += d; if (/ready/.test(o)) { clearTimeout(t); resolve(); } });
  });
}

// Ask the signaling server directly whether a room code still exists.
function codeStillJoinable(code) {
  return new Promise((resolve) => {
    const ws = new WS(`ws://127.0.0.1:${PORT}`);
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', code })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'joined') finish(true);
      else if (m.t === 'err') finish(false);
    });
    ws.on('error', () => finish(false));
    setTimeout(() => finish(false), 4000);
  });
}

async function startApp(port, userDataDir, env) {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  children.push(spawn(APP, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    { env: { ...process.env, YSHARE_TEST_HIDDEN: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] }));
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) fail('devtools never came up');
  const cdp = await new Promise((resolve, reject) => {
    const ws = new WS(target.webSocketDebuggerUrl);
    let id = 0; const pending = new Map(); const errors = [];
    ws.on('open', () => resolve({
      errors,
      send(method, params) {
        const i = ++id;
        return new Promise((res, rej) => { pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
      },
    }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); if (m.error) rej(new Error(m.error.message)); else res(m.result); }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    });
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.eval = async (e) => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(r.exceptionDetails.text);
    return r.result.value;
  };
  return cdp;
}

(async () => {
  await startSignaling();
  step('signaling', `up on ${PORT}`);

  const sendDir = path.join(SCRATCH, 'int-send');
  fs.rmSync(sendDir, { recursive: true, force: true });
  fs.mkdirSync(sendDir, { recursive: true });
  const src = path.join(sendDir, 'x.bin');
  fs.writeFileSync(src, crypto.randomBytes(4096));

  const app = await startApp(9411, path.join(SCRATCH, 'ud-int'), { YSHARE_TEST_PICK: src });
  await sleep(2500);

  await app.eval(`(async () => {
    document.getElementById('serverIn').value = 'ws://localhost:${PORT}';
    document.getElementById('btnSaveServer').click();
    await new Promise(r => setTimeout(r, 500));
  })()`);
  step('server saved', await app.eval(`document.getElementById('srvMsg').textContent`));

  const code = await app.eval(`(async () => {
    document.getElementById('btnPick').click();
    await new Promise(r => setTimeout(r, 900));
    document.getElementById('btnQuickSend').click();
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500));
      const c = document.getElementById('quickCodeOut').textContent.trim();
      if (c) return c;
    }
    return '';
  })()`);
  step('claim code issued', code || '(none)');
  if (!/^[A-Z0-9]{6}$/.test(code)) fail('no claim code to test with');

  step('code joinable BEFORE remove', await codeStillJoinable(code) ? 'yes (expected)' : 'NO - test setup broken');

  // The moment under test: the person removes the server while that code is live.
  await app.eval(`(async () => {
    document.getElementById('btnClearServer').click();
    await new Promise(r => setTimeout(r, 900));
  })()`);
  step('message shown', await app.eval(`document.getElementById('srvMsg').textContent`));

  const shown = await app.eval(`document.getElementById('quickCodeOut').textContent.trim()`);
  step('code still on screen?', shown ? `YES: ${shown}  <-- BUG` : 'no, cleared');

  const joinable = await codeStillJoinable(code);
  step('code still joinable?', joinable ? 'YES  <-- BUG' : 'no, room is gone');

  step('quick connect closed', await app.eval(`document.getElementById('btnQuickJoin').disabled`));
  step('console errors', app.errors.length ? app.errors.join(' | ') : '(none)');

  if (shown) fail('a dead claim code was left on screen');
  if (joinable) fail('the claim code was still redeemable on the removed server');
  if (app.errors.length) fail('console errors during the interrupt');

  console.log('\nRESULT: PASS - removing the server kills the live code and its room.');
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(0), 600);
})().catch((e) => {
  console.error('\nRESULT: FAIL -', e.message);
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(1), 600);
});
