// Verification harness — runs the SAME range-split + positioned-reassembly protocol
// as the real app (renderer.js), through the configured relay, with a deterministic data
// pattern, and checks every byte arrives correct. Proves the multi-connection logic
// is correct (not just fast) before any GUI/owner test. In-memory (no disk) so it
// isolates the protocol; the app adds standard positioned disk writes on top.

const P = new URLSearchParams(location.search);
const NPC   = parseInt(P.get('pc') || '8', 10);
const CHUNK = parseInt(P.get('chunk') || String(64 * 1024), 10);
const TOTAL = Math.round(parseFloat(P.get('mb') || '20') * 1024 * 1024);
const T = (P.get('t') || 'both').toLowerCase();
let RTC;
const L = (...a) => console.log('[V]', ...a);

function selectUrls(urls) {
  if (T === 'both') return urls;
  if (T === 'tcp') return urls.filter(url => /[?&]transport=tcp(?:&|$)/i.test(url));
  if (T === 'udp') return urls.filter(url => !/[?&]transport=tcp(?:&|$)/i.test(url));
  throw new Error(`unknown transport "${T}" (use udp, tcp, or both)`);
}

// deterministic source pattern + reassembly target
const src = new Uint8Array(TOTAL);
for (let i = 0; i < TOTAL; i++) src[i] = (i * 131 + 7) & 0xff;
const dest = new Uint8Array(TOTAL);

let received = 0, firstByte = 0, finished = false;

function wirePair(start, end) {
  return new Promise((resolve, reject) => {
    const s = new RTCPeerConnection(RTC), r = new RTCPeerConnection(RTC);
    s.onicecandidate = e => { if (e.candidate) r.addIceCandidate(e.candidate).catch(() => {}); };
    r.onicecandidate = e => { if (e.candidate) s.addIceCandidate(e.candidate).catch(() => {}); };
    r.ondatachannel = e => {
      const ch = e.channel; ch.binaryType = 'arraybuffer';
      const st = { start: 0, pos: 0 };       // mirrors renderer.js chanState
      ch.onmessage = ev => {
        if (typeof ev.data === 'string') { const m = JSON.parse(ev.data); if (m.type === 'meta') st.start = m.start; return; }
        if (!firstByte) firstByte = performance.now();
        const d = new Uint8Array(ev.data);
        dest.set(d, st.start + st.pos);       // positioned reassembly (same math as the app)
        st.pos += d.byteLength; received += d.byteLength;
        if (received >= TOTAL && !finished) { finished = true; verify(); }
      };
    };
    const dc = s.createDataChannel('c', { ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onopen = () => resolve({ dc, start, end });
    (async () => {
      try {
        const o = await s.createOffer(); await s.setLocalDescription(o);
        await r.setRemoteDescription(o);
        const a = await r.createAnswer(); await r.setLocalDescription(a);
        await s.setRemoteDescription(a);
      } catch (e) { reject(e); }
    })();
  });
}

function drain(dc) {
  return new Promise(res => { const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); }; dc.addEventListener('bufferedamountlow', h); });
}

async function sendRange(dc, start, end) {
  dc.send(JSON.stringify({ type: 'meta', start }));
  let off = start;
  while (off < end) {
    if (dc.bufferedAmount > 1048576) await drain(dc);
    const len = Math.min(CHUNK, end - off);
    dc.send(src.subarray(off, off + len));
    off += len;
  }
}

function verify() {
  let ok = true, badAt = -1;
  for (let i = 0; i < TOTAL; i++) { if (dest[i] !== src[i]) { ok = false; badAt = i; break; } }
  const dur = (performance.now() - firstByte) / 1000;
  L(`integrity: ${ok ? 'PASS ✓ (every byte correct)' : 'FAIL ✗ at byte ' + badAt}`);
  L(`RESULT  pc=${NPC} chunk=${CHUNK / 1024}K  ->  ${(TOTAL / 1048576).toFixed(0)}MB in ${dur.toFixed(1)}s  =  ${(received / dur / 1024).toFixed(0)} KB/s`);
  L('HARNESS_DONE');
}

(async () => {
  const turn = await window.yshareHarness.getTurnConfig();
  const urls = selectUrls(turn.urls);
  if (urls.length === 0) throw new Error(`no ${T} TURN URL was provided`);
  RTC = {
    iceServers: [{ urls, username: turn.username, credential: turn.credential }],
    iceTransportPolicy: 'relay',
  };
  L(`verify config: pc=${NPC} chunk=${CHUNK / 1024}K total=${(TOTAL / 1048576).toFixed(0)}MB t=${T}`);
  const ranges = [];
  for (let i = 0; i < NPC; i++) ranges.push({ start: Math.floor(i * TOTAL / NPC), end: Math.floor((i + 1) * TOTAL / NPC) });
  let conns;
  try { conns = await Promise.all(ranges.map(rg => wirePair(rg.start, rg.end))); }
  catch (e) { L('connect ERROR ' + e.message); L('HARNESS_DONE'); return; }
  L(`connected ${conns.length} pairs — streaming + verifying...`);
  await Promise.all(conns.map(c => sendRange(c.dc, c.start, c.end)));
  L('all data queued — waiting for reassembly...');
})().catch(e => { L('FATAL ' + e.message); L('HARNESS_DONE'); });
