// Score v4 — pure teaser (26s). Same premium ambient world as v3, retimed for
// the new scenes, plus a soft gliding tone that travels WITH the ember and a
// warm arrival note. No drums. Writes 44.1kHz 16-bit stereo WAV.
// Usage: node audio4-gen.js <out.wav>
const fs = require('fs');
const SR = 44100;
const DUR = 26;
const N = SR * DUR;
const L = new Float64Array(N);
const R = new Float64Array(N);

function add(startSec, gen, gL = 1, gR = 1) {
  const s0 = Math.floor(startSec * SR);
  gen((i, v) => {
    const idx = s0 + i;
    if (idx >= 0 && idx < N) { L[idx] += v * gL; R[idx] += v * gR; }
  });
}

function drone(e, freq, durSec, vel = 1) {
  const len = Math.floor(SR * durSec);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const breathe = 0.72 + 0.28 * Math.sin(2 * Math.PI * t / 9.5);
    const env = Math.min(1, t / 3.2) * Math.min(1, (durSec - t) / 3.5) * breathe;
    const v = Math.sin(2 * Math.PI * freq * t) * 0.5
      + Math.sin(2 * Math.PI * freq * 1.0045 * t) * 0.35
      + Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.45
      + Math.sin(2 * Math.PI * freq * 2.002 * t) * 0.10;
    e(i, v * env * 0.065 * vel);
  }
}
function felt(e, freq, vel = 1) {
  const len = Math.floor(SR * 3.4);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.025) * Math.exp(-t * 1.35);
    const v = Math.sin(2 * Math.PI * freq * t) * 0.62
      + Math.sin(2 * Math.PI * freq * 2 * t) * 0.20 * Math.exp(-t * 2.6)
      + Math.sin(2 * Math.PI * freq * 3 * t) * 0.07 * Math.exp(-t * 4)
      + Math.sin(2 * Math.PI * freq * 0.5 * t) * 0.12;
    e(i, v * env * 0.16 * vel);
  }
}
function swell(e, durSec, freq = 41.2, vel = 1) {
  const len = Math.floor(SR * durSec);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.sin(Math.PI * (i / len)) ** 1.6;
    e(i, Math.sin(2 * Math.PI * freq * t) * env * 0.16 * vel);
  }
}
function air(e, durSec, vel = 1) {
  const len = Math.floor(SR * durSec);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const n = Math.random() * 2 - 1;
    lp += 0.045 * (n - lp);
    const env = Math.sin(Math.PI * (i / len)) ** 2;
    e(i, lp * env * 0.30 * vel);
  }
}
function bloom(e, durSec, vel = 1) {
  const len = Math.floor(SR * durSec);
  const fs_ = [587.33, 880.0, 1174.66, 1760.0];
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 1.6) * Math.min(1, (durSec - t) / 2.2);
    let v = 0;
    for (let k = 0; k < fs_.length; k++) {
      v += Math.sin(2 * Math.PI * fs_[k] * (1 + 0.0007 * Math.sin(t * 1.3 + k)) * t) * (0.5 ** k);
    }
    e(i, v * env * 0.028 * vel);
  }
}
// The traveler: a quiet sine that glides up as the ember crosses (A3 → A4),
// panned left→right with it.
function glide(durSec, f0, f1, vel = 1) {
  const len = Math.floor(SR * durSec);
  const s0 = Math.floor(9.2 * SR);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const u = i / len;
    const f = f0 * Math.pow(f1 / f0, u);
    phase += 2 * Math.PI * f / SR;
    const env = Math.sin(Math.PI * u) ** 1.3;
    const v = (Math.sin(phase) * 0.8 + Math.sin(phase * 2.001) * 0.2) * env * 0.055 * vel;
    const idx = s0 + i;
    if (idx >= 0 && idx < N) { L[idx] += v * (1 - u * 0.85); R[idx] += v * (0.15 + u * 0.85); }
  }
}

// --- arrangement --------------------------------------------------------------
add(0.0, (e) => drone(e, 73.42, 26, 1.0));           // D2 bed
add(12.6, (e) => drone(e, 87.31, 13.0, 0.55));       // F2 joins at the arrival

// whisper open
add(1.0, (e) => felt(e, 293.66, 0.7));               // D4

// letterform
add(3.1, (e) => air(e, 1.5, 0.75));
add(3.7, (e) => felt(e, 587.33, 0.55));              // D5

// journey: route draws, ember departs, glides, arrives
add(7.3, (e) => air(e, 1.5, 0.7));
add(7.7, (e) => felt(e, 440.0, 0.45));               // A4 — the route appears
glide(3.4, 220.0, 440.0, 1.0);                        // the traveler (9.2 → 12.6)
add(12.45, (e) => swell(e, 2.8, 36.71, 0.9));        // arrival lands in the chest
add(12.6, (e) => felt(e, 587.33, 0.7));              // D5 — arrival
add(12.6, (e) => felt(e, 440.0, 0.5));

// the promise
add(14.1, (e) => air(e, 1.4, 0.65));
add(14.6, (e) => felt(e, 349.23, 0.6));              // F4

// the name
add(17.7, (e) => air(e, 1.6, 0.8));
add(18.0, (e) => swell(e, 4.4, 36.71, 1.0));
add(18.6, (e) => felt(e, 146.83, 0.9));              // D3
add(18.6, (e) => felt(e, 220.0, 0.7));               // A3
add(19.3, (e) => felt(e, 293.66, 0.75));             // D4
add(20.1, (e) => felt(e, 440.0, 0.5));               // A4
add(18.8, (e) => bloom(e, 4.6, 1.0));
add(22.4, (e) => felt(e, 587.33, 0.35));             // last distant D5

// room air
for (let i = 0; i < N; i++) {
  L[i] += (Math.random() * 2 - 1) * 0.0028;
  R[i] += (Math.random() * 2 - 1) * 0.0028;
}

// master
for (let i = 0; i < N; i++) {
  const fadeIn = Math.min(1, i / (SR * 0.6));
  const fadeOut = Math.min(1, (N - i) / (SR * 2.0));
  L[i] = Math.tanh(L[i] * 1.05) * 0.9 * fadeIn * fadeOut;
  R[i] = Math.tanh(R[i] * 1.05) * 0.9 * fadeIn * fadeOut;
}

const bytes = Buffer.alloc(44 + N * 4);
bytes.write('RIFF', 0); bytes.writeUInt32LE(36 + N * 4, 4); bytes.write('WAVE', 8);
bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(SR, 24); bytes.writeUInt32LE(SR * 4, 28);
bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
bytes.write('data', 36); bytes.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  bytes.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
fs.writeFileSync(process.argv[2], bytes);
console.log(`wrote ${process.argv[2]} (${(bytes.length / 1048576).toFixed(1)} MB, ${DUR}s)`);
