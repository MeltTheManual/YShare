// Relay throughput harness - runs entirely in this renderer.
// Creates NPC sender/receiver PAIRS (each = its own SCTP association), each with
// NCH data channels, forces them through the configured relay, streams TOTAL bytes,
// and reports the delivered average + RTT + relay transport (UDP/TCP).

const P = new URLSearchParams(location.search);
const NPC   = parseInt(P.get('pc')    || '1', 10);          // peer-connection pairs
const NCH   = parseInt(P.get('ch')    || '1', 10);          // data channels per pair
const CHUNK = parseInt(P.get('chunk') || String(64 * 1024), 10);
const TOTAL = Math.round(parseFloat(P.get('mb') || '20') * 1024 * 1024);

const T = (P.get('t') || 'both').toLowerCase();   // udp | tcp | both
let RTC;

const L = (...a) => console.log('[H]', ...a);

let received = 0, firstByte = 0, finished = false;
const allChannels = [];

function selectUrls(urls) {
  if (T === 'both') return urls;
  if (T === 'tcp') return urls.filter(url => /[?&]transport=tcp(?:&|$)/i.test(url));
  if (T === 'udp') return urls.filter(url => !/[?&]transport=tcp(?:&|$)/i.test(url));
  throw new Error(`unknown transport "${T}" (use udp, tcp, or both)`);
}

function wirePair() {
  return new Promise((resolve, reject) => {
    const s = new RTCPeerConnection(RTC);   // sender
    const r = new RTCPeerConnection(RTC);   // receiver
    s.onicecandidate = e => { if (e.candidate) r.addIceCandidate(e.candidate).catch(() => {}); };
    r.onicecandidate = e => { if (e.candidate) s.addIceCandidate(e.candidate).catch(() => {}); };
    r.ondatachannel = e => {
      const ch = e.channel; ch.binaryType = 'arraybuffer';
      ch.onmessage = ev => {
        if (typeof ev.data === 'string') return;
        if (!firstByte) firstByte = performance.now();
        received += ev.data.byteLength;
        if (received >= TOTAL && !finished) finish(s);
      };
    };
    let opened = 0;
    for (let i = 0; i < NCH; i++) {
      const dc = s.createDataChannel('c' + i, { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = 256 * 1024;
      dc.onopen = () => { if (++opened === NCH) resolve(s); };
      allChannels.push(dc);
    }
    (async () => {
      try {
        const offer = await s.createOffer(); await s.setLocalDescription(offer);
        await r.setRemoteDescription(offer);
        const ans = await r.createAnswer(); await r.setLocalDescription(ans);
        await s.setRemoteDescription(ans);
      } catch (e) { reject(e); }
    })();
  });
}

async function reportTransport(pc) {
  try {
    const stats = await pc.getStats();
    let rtt = null, proto = null;
    stats.forEach(x => {
      if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded' && x.currentRoundTripTime != null)
        rtt = Math.round(x.currentRoundTripTime * 1000);
      if (x.type === 'local-candidate' && x.candidateType === 'relay')
        proto = x.relayProtocol || x.protocol;
    });
    L(`transport: relay/${(proto || '?').toUpperCase()}  RTT=${rtt != null ? rtt + 'ms' : '?'}`);
  } catch (e) { L('stats err: ' + e.message); }
}

function drain(dc) {
  return new Promise(res => {
    const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); };
    dc.addEventListener('bufferedamountlow', h);
  });
}

async function finish(samplePc) {
  if (finished) return; finished = true;
  const dur = (performance.now() - firstByte) / 1000;
  await reportTransport(samplePc);
  const avg = received / dur / 1024;
  L(`RESULT  pc=${NPC} ch=${NCH} chunk=${(CHUNK / 1024)}K  ->  ${(received / 1048576).toFixed(0)}MB in ${dur.toFixed(1)}s  =  ${avg.toFixed(0)} KB/s`);
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
  L(`config: pc=${NPC} ch=${NCH} chunk=${CHUNK / 1024}K total=${(TOTAL / 1048576).toFixed(0)}MB`);
  try {
    await Promise.all(Array.from({ length: NPC }, () => wirePair()));
  } catch (e) { L('connect ERROR: ' + e.message); L('HARNESS_DONE'); return; }
  L(`connected: ${NPC} pair(s), ${allChannels.length} channel(s) open — streaming...`);

  const perChHigh = Math.max(256 * 1024, Math.floor((8 * 1024 * 1024) / allChannels.length));
  const buf = new Uint8Array(CHUNK);
  let sent = 0, idx = 0;
  while (sent < TOTAL) {
    const dc = allChannels[idx % allChannels.length];
    if (dc.bufferedAmount > perChHigh) { await drain(dc); }
    const len = Math.min(CHUNK, TOTAL - sent);
    try { dc.send(len === CHUNK ? buf : buf.subarray(0, len)); }
    catch (e) { L('send ERROR: ' + e.message); break; }
    sent += len; idx++;
  }
  L('all data queued — waiting for receiver to drain...');
})().catch(e => { L('FATAL ' + e.message); L('HARNESS_DONE'); });
