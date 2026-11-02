/**
 * Синтез 20-секундного саундтрека: 120 BPM, A minor.
 * Без сторонних сэмплов и лицензий — всё считается математикой.
 */
import fs from 'node:fs';

const SR = 48000;
const DUR = 20;
const N = SR * DUR;
const L = new Float32Array(N);
const R = new Float32Array(N);
const BEAT = 60 / 120; // 0.5 s
const BAR = BEAT * 4;

const notes = { A1: 55, F1: 43.65, C2: 65.41, G1: 49 };

function add(i, v, pan = 0) {
  if (i < 0 || i >= N) return;
  L[i] += v * (1 - Math.max(0, pan) * 0.7);
  R[i] += v * (1 + Math.min(0, pan) * 0.7);
}

function kick(t0, gain = 0.95) {
  const len = Math.floor(0.4 * SR);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 150 * Math.exp(-t * 22) + 42;
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 9) * (1 - Math.exp(-t * 400));
    add(Math.floor(t0 * SR) + i, Math.sin(phase) * env * gain);
  }
}

function noiseBurst(t0, dur, gain, decay, hp = 0) {
  const len = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * 0.12;
    const v = hp > 0 ? n - lp : lp;
    const env = Math.exp(-t * decay) * (1 - Math.exp(-t * 900));
    add(Math.floor(t0 * SR) + i, v * env * gain);
  }
}

function hat(t0, gain = 0.16) {
  const len = Math.floor(0.06 * SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * 0.5;
    const env = Math.exp(-t * 90);
    add(Math.floor(t0 * SR) + i, (n - lp) * env * gain, 0.15);
  }
}

function saw(freq, t) {
  const x = (freq * t) % 1;
  return x * 2 - 1;
}

function bass(t0, freq, dur = 0.48, gain = 0.28) {
  const len = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.008) * Math.exp(-t * 5);
    const v = saw(freq, t) * 0.6 + Math.sin(2 * Math.PI * freq * t) * 0.4;
    lp += (v - lp) * 0.08;
    add(Math.floor(t0 * SR) + i, lp * env * gain);
  }
}

function pad(t0, freqs, dur, gain = 0.07) {
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.6) * Math.min(1, (dur - t) / 0.4);
    let v = 0;
    for (const f of freqs) {
      v += saw(f, t) * 0.33 + saw(f * 1.005, t) * 0.33;
    }
    add(Math.floor(t0 * SR) + i, v * env * gain);
  }
}

function riser(t0, dur = 1.2, gain = 0.25) {
  const len = Math.floor(dur * SR);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const k = t / dur;
    const n = Math.random() * 2 - 1;
    lp += (n - lp) * (0.02 + k * 0.35);
    const env = Math.pow(k, 2) * (1 - Math.exp(-t * 20));
    add(Math.floor(t0 * SR) + i, lp * env * gain);
  }
}

function chime(t0, gain = 0.22) {
  for (const [f, d] of [[880, 0.9], [1318.5, 0.7], [1760, 0.5]]) {
    const len = Math.floor(d * SR);
    for (let i = 0; i < len; i++) {
      const t = i / SR;
      const env = Math.exp(-t * 4.5) * (1 - Math.exp(-t * 500));
      add(Math.floor(t0 * SR) + i, Math.sin(2 * Math.PI * f * t) * env * gain / 2, 0.2);
    }
  }
}

function subDrop(t0, gain = 0.8) {
  const len = Math.floor(1.1 * SR);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / SR;
    const f = 90 * Math.exp(-t * 3.2) + 28;
    phase += (2 * Math.PI * f) / SR;
    const env = Math.exp(-t * 2.2) * (1 - Math.exp(-t * 60));
    add(Math.floor(t0 * SR) + i, Math.sin(phase) * env * gain);
  }
}

/* ── ритм ── */
for (let b = 0; b < DUR / BEAT; b++) {
  const t = b * BEAT;
  kick(t);
  if (b % 2 === 1) noiseBurst(t, 0.16, 0.22, 22, 1);
  hat(t + 0.25, 0.12);
  if (b % 4 === 3) hat(t + 0.375, 0.08);
}

/* ── бас и пэд по тактам ── */
const progression = [
  [notes.A1, [220, 261.6, 329.6]],
  [notes.F1, [174.6, 220, 261.6]],
  [notes.C2, [196, 261.6, 329.6]],
  [notes.G1, [196, 246.9, 293.7]],
];
for (let bar = 0; bar < DUR / BAR; bar++) {
  const [root, chord] = progression[bar % progression.length];
  for (let b = 0; b < 4; b++) bass(bar * BAR + b * BEAT, root);
  pad(bar * BAR, chord, BAR * 0.95);
}

/* ── акценты ── */
subDrop(0);
chime(0.9);
riser(4.1, 0.9);
kick(5.0, 1);
chime(10.1);
riser(9.2, 0.9);
kick(10.0, 1);
riser(14.2, 0.8);
kick(15.0, 1);
chime(15.2);
kick(19.0, 0.9);

/* ── нормализация и WAV ── */
let peak = 0;
for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const norm = peak > 0 ? 0.92 / peak : 1;
const data = Buffer.alloc(44 + N * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + N * 4, 4);
data.write('WAVE', 8);
data.write('fmt ', 12);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20);
data.writeUInt16LE(2, 22);
data.writeUInt32LE(SR, 24);
data.writeUInt32LE(SR * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  const l = Math.tanh(L[i] * norm);
  const r = Math.tanh(R[i] * norm);
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l * 32767))), 44 + i * 4);
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r * 32767))), 46 + i * 4);
}
fs.mkdirSync('media/audio', { recursive: true }); fs.writeFileSync('media/audio/audio.wav', data);
console.log('audio.wav', (data.length / 1024 / 1024).toFixed(1), 'MB');
