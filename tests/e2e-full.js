// Full end-to-end test of the shipped product, with no owner-funded infrastructure.
//
//   1. start the bundled signaling service in signaling-only mode (YSHARE_NO_TURN=1)
//   2. launch TWO PACKAGED YShare apps, hidden, each with a FRESH settings folder
//   3. confirm Quick Connect is closed on a fresh install
//   4. point both at ws://localhost:8443 through the real settings UI
//   5. transfer a single file: pick, claim code, offer review, Accept, verify
//   6. transfer a folder with nested paths, an empty file, and a spaced name
//   7. compare everything byte-for-byte on disk
//
// Every dialog is bypassed with the app's own test hooks, and both windows stay
// hidden, so this never steals focus.
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
const SIGNAL_PORT = 8443;
const children = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { throw new Error(msg); };
const step = (name, value) => console.log('  ' + String(name).padEnd(38), value);

function startSignaling() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: path.join(REPO, 'signaling'),
      env: { ...process.env, NODE_ENV: 'development', YSHARE_NO_TURN: '1', PORT: String(SIGNAL_PORT), TURN_SECRET: '', TURN_HOST: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    const timer = setTimeout(() => reject(new Error('signaling did not start: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (/yshare-signal ready/.test(out)) { clearTimeout(timer); resolve(out.trim().split('\n').pop()); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
  });
}

async function startApp(label, port, userDataDir, extraEnv) {
  fs.rmSync(userDataDir, { recursive: true, force: true });   // fresh install, every run
  const child = spawn(APP, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    { env: { ...process.env, YSHARE_TEST_HIDDEN: '1', ...(extraEnv || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) fail(`${label}: devtools never came up`);

  const cdp = await new Promise((resolve, reject) => {
    const ws = new WS(target.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const errors = [];
    ws.on('open', () => resolve({
      label, errors,
      send(method, params) {
        const msgId = ++id;
        return new Promise((res, rej) => {
          pending.set(msgId, { res, rej });
          ws.send(JSON.stringify({ id: msgId, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch {} },
    }));
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message)); else res(m.result);
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    });
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  cdp.eval = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) fail(`${label}: ${r.exceptionDetails.text}`);
    return r.result.value;
  };
  return cdp;
}

// Wait for a claim code after clicking "get quick code".
const GET_CODE = `(async () => {
  const btn = document.getElementById('btnQuickSend');
  if (btn.disabled) return '(disabled) ' + document.getElementById('statusText').textContent;
  btn.click();
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 500));
    const c = document.getElementById('quickCodeOut').textContent.trim();
    if (c) return c;
  }
  return '(no code) ' + document.getElementById('statusText').textContent;
})()`;

// Join with a code, wait for the offer, accept it, wait for the terminal result.
function joinAcceptScript(code) {
  return `(async () => {
    document.getElementById('quickIn').value = ${JSON.stringify(code)};
    document.getElementById('btnQuickJoin').click();
    let seen = '';
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (document.getElementById('incomingCard').style.display !== 'none') {
        seen = document.getElementById('incName').textContent + ' | ' + document.getElementById('incSize').textContent;
        break;
      }
    }
    if (!seen) return { offer: '(no offer arrived)', result: '' };
    document.getElementById('btnAccept').click();
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 500));
      const r2 = document.getElementById('recvResult').textContent.trim();
      if (r2) return { offer: seen, result: r2 };
    }
    return { offer: seen, result: '(no result)' };
  })()`;
}

function pickScript(buttonId) {
  return `(async () => {
    document.getElementById('${buttonId}').click();
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 250));
      const info = document.getElementById('fileInfo').textContent.trim();
      if (info) return info;
    }
    return '(nothing picked)';
  })()`;
}

(async () => {
  console.log('=== 1. self-hosted signaling, no relay, nothing paid ===');
  step('server', await startSignaling());

  const sendDir = path.join(SCRATCH, 'e2e-send');
  const recvDir = path.join(SCRATCH, 'e2e-recv');
  for (const d of [sendDir, recvDir]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }

  // Single file: random bytes, so a matching hash cannot be luck.
  const srcPath = path.join(sendDir, 'launch-check.bin');
  const payload = crypto.randomBytes(3 * 1024 * 1024 + 12345);
  fs.writeFileSync(srcPath, payload);
  const srcHash = crypto.createHash('sha256').update(payload).digest('hex');
  step('source file', `${payload.length} bytes  sha256=${srcHash.slice(0, 16)}...`);

  // Folder: nested paths, an empty file, and a name with a space.
  const folderRoot = path.join(sendDir, 'parcel');
  fs.mkdirSync(path.join(folderRoot, 'nested', 'deeper'), { recursive: true });
  const folderFiles = {
    'readme.txt': Buffer.from('top level file\n'),
    'empty.bin': Buffer.alloc(0),
    'nested/data.bin': crypto.randomBytes(400 * 1024),
    'nested/deeper/leaf spaced.bin': crypto.randomBytes(64 * 1024 + 7),
  };
  for (const rel of Object.keys(folderFiles)) {
    fs.writeFileSync(path.join(folderRoot, rel.split('/').join(path.sep)), folderFiles[rel]);
  }
  step('source folder', `${Object.keys(folderFiles).length} files, incl. empty + nested + spaced name`);

  console.log('\n=== 2. two hidden packaged apps, fresh installs ===');
  const sender = await startApp('sender', 9401, path.join(SCRATCH, 'ud-a'), { YSHARE_TEST_PICK: srcPath, YSHARE_TEST_PICKFOLDER: folderRoot });
  const receiver = await startApp('receiver', 9402, path.join(SCRATCH, 'ud-b'), { YSHARE_TEST_PICKDIR: recvDir });
  await sleep(2500);

  console.log('\n=== 3. fresh install: quick connect must be CLOSED ===');
  const senderClosed = await sender.eval(`document.getElementById('btnQuickSend').disabled`);
  const receiverClosed = await receiver.eval(`document.getElementById('btnQuickJoin').disabled`);
  step('sender quick send disabled', senderClosed);
  step('receiver connect disabled', receiverClosed);
  step('manual fallback offered', await sender.eval(`document.getElementById('manualSend').style.display === ''`));
  if (!senderClosed || !receiverClosed) fail('quick connect was open on a fresh install');

  console.log('\n=== 4. point both at the self-hosted server, through the UI ===');
  for (const app of [sender, receiver]) {
    step(`${app.label} save`, await app.eval(`(async () => {
      document.getElementById('serverIn').value = 'ws://localhost:${SIGNAL_PORT}';
      document.getElementById('btnSaveServer').click();
      await new Promise(r => setTimeout(r, 500));
      return document.getElementById('srvMsg').textContent;
    })()`));
  }
  step('receiver save folder', await receiver.eval(`window.yshare.pickDownloadDir()`));

  console.log('\n=== 5. single file ===');
  step('sender picked', await sender.eval(pickScript('btnPick')));
  const code = await sender.eval(GET_CODE);
  step('claim code', code);
  if (!/^[A-Z0-9]{6}$/.test(code)) fail('sender never produced a claim code: ' + code);

  const fileRun = await receiver.eval(joinAcceptScript(code));
  step('offer shown', fileRun.offer);
  step('receiver result', fileRun.result);
  step('sender result', await sender.eval(`document.getElementById('sendResult').textContent.trim()`));

  const gotFile = path.join(recvDir, 'launch-check.bin');
  if (!fs.existsSync(gotFile)) fail('no received file on disk');
  const gotHash = crypto.createHash('sha256').update(fs.readFileSync(gotFile)).digest('hex');
  step('received sha256', gotHash.slice(0, 16) + '...');
  step('FILE MATCHES', gotHash === srcHash ? 'YES - byte-identical' : 'NO - CORRUPT');
  if (gotHash !== srcHash) fail('received file does not match the source');

  console.log('\n=== 6. folder ===');
  await sender.eval(`document.getElementById('btnSendNew').click()`).catch(() => null);
  await receiver.eval(`document.getElementById('btnRecvNew').click()`).catch(() => null);
  await sleep(2000);
  await sender.eval(`document.getElementById('modeSend').click()`);
  await receiver.eval(`document.getElementById('modeRecv').click()`);
  await sleep(500);

  step('sender picked folder', await sender.eval(pickScript('btnPickFolder')));
  const folderCode = await sender.eval(GET_CODE);
  step('claim code', folderCode);
  if (!/^[A-Z0-9]{6}$/.test(folderCode)) fail('no claim code for the folder: ' + folderCode);

  const folderRun = await receiver.eval(joinAcceptScript(folderCode));
  step('offer shown', folderRun.offer);
  step('receiver result', folderRun.result);

  const gotRoot = path.join(recvDir, 'parcel');
  let allMatch = fs.existsSync(gotRoot);
  if (!allMatch) step('folder root', 'MISSING at ' + gotRoot);
  for (const rel of Object.keys(folderFiles)) {
    const target = path.join(gotRoot, rel.split('/').join(path.sep));
    if (!fs.existsSync(target)) { allMatch = false; step('  ' + rel, 'MISSING'); continue; }
    const got = fs.readFileSync(target);
    const same = got.equals(folderFiles[rel]);
    if (!same) allMatch = false;
    step('  ' + rel, `${got.length} B  ${same ? 'ok' : 'MISMATCH'}`);
  }
  step('FOLDER MATCHES', allMatch ? 'YES - every file byte-identical' : 'NO');
  if (!allMatch) fail('folder contents did not survive the transfer');

  console.log('\n=== console errors ===');
  step('sender', sender.errors.length ? sender.errors.join(' | ') : '(none)');
  step('receiver', receiver.errors.length ? receiver.errors.join(' | ') : '(none)');
  // A transfer can succeed while the app quietly complains. An invalid CSP source
  // did exactly that once, so console errors now fail the run.
  if (sender.errors.length || receiver.errors.length) {
    fail('the apps logged console errors during a successful transfer');
  }

  console.log('\nRESULT: PASS - file and folder both transferred over a self-hosted server and verified byte-for-byte.');
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(0), 800);
})().catch((err) => {
  console.error('\nRESULT: FAIL -', err.message);
  for (const c of children) { try { c.kill(); } catch {} }
  setTimeout(() => process.exit(1), 800);
});
