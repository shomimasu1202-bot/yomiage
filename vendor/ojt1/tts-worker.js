/* 読み上げくん: on-device Japanese speech (Open JTalk + HTS voice "Mei") in a worker.
 * Text is converted to sound here, inside the phone. Nothing is sent anywhere. */
import { createOjt } from './ojt-core.js';

const TOTAL_BYTES = 25367487; // dictionary + voice (gzip), for the progress bar
const OUT_RATE = 24000;
const GAIN = 2.4; // Mei is quiet; raise to a normal listening level
function clip(v) {
  v *= GAIN;
  const a = v < 0 ? -v : v;
  if (a > 24000) v = (v < 0 ? -1 : 1) * Math.min(32767, 24000 + (a - 24000) * 0.3);
  return v;
}
let ojt = null;
let initPromise = null;

function init() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const wasmUrl = new URL('./openjtalk-wasm.wasm', import.meta.url).href;
    const m = await createOjt({ locateFile: (f) => (f.endsWith('.wasm') ? wasmUrl : f) });
    let got = 0, last = 0;
    await m.configure(new URL('./dic', import.meta.url).href, new URL('./mei_normal.htsvoice.gz', import.meta.url).href, (n) => {
      got += n;
      const now = Date.now();
      if (now - last > 250) { last = now; postMessage({ type: 'progress', got, total: TOTAL_BYTES }); }
    });
    postMessage({ type: 'progress', got: TOTAL_BYTES, total: TOTAL_BYTES });
    ojt = m;
  })();
  initPromise.catch(() => { initPromise = null; });
  return initPromise;
}

// Keep each synthesis call short enough for the engine's buffers: split long text at 、 or spaces.
function pieces(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return [text];
  let best = -1;
  const mid = chars.length / 2;
  for (let i = 1; i < chars.length - 1; i++) {
    if ('、，,　 ・'.indexOf(chars[i]) >= 0 && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  const cut = best > 0 ? best + 1 : Math.floor(mid);
  return pieces(chars.slice(0, cut).join(''), max).concat(pieces(chars.slice(cut).join(''), max));
}

function speakable(s) {
  // Drop marks the engine reads oddly or not at all; keep Japanese text, digits, letters and punctuation.
  return s.replace(/[—―─━]+/g, '、').replace(/[【】〔〕［］\[\]〈〉《》]/g, '、').replace(/[※＊*#＃|｜_＿^]/g, ' ')
    .replace(/、{2,}/g, '、').replace(/^[、。，．・\s「『（(]+/, '');
}

function toRate24k(pcm, sr) {
  // pcm: Float32Array in int16 range at sr (48000 for Mei)
  const step = sr / OUT_RATE;
  const n = Math.floor(pcm.length / step);
  const out = new Int16Array(n);
  if (step === 2) {
    for (let i = 0; i < n; i++) {
      // small low-pass: weighted average of 4 neighbours
      const j = i * 2;
      const a = pcm[j - 1] || 0, b = pcm[j], c = pcm[j + 1] || 0, d = pcm[j + 2] || 0;
      out[i] = clip((a + 3 * b + 3 * c + d) / 8);
    }
  } else {
    for (let i = 0; i < n; i++) {
      out[i] = clip(pcm[Math.floor(i * step)]);
    }
  }
  return out;
}

function synth(text, speed) {
  const parts = pieces(speakable(text), 150);
  const outs = [];
  let total = 0;
  const gap = new Int16Array(Math.round(OUT_RATE * 0.12));
  for (const p of parts) {
    if (!p.replace(/[\s、。，．,.!?！？「」『』（）()…・]/g, '')) continue;
    let r = null;
    try { r = ojt.synthesize(p, { speed: speed || 1 }); } catch (e) { r = null; }
    if (!r || !r.pcm.length) continue;
    const a = toRate24k(r.pcm, r.sampleRate);
    if (outs.length) { outs.push(gap); total += gap.length; }
    outs.push(a); total += a.length;
  }
  if (!total) { const s = new Int16Array(Math.round(OUT_RATE * 0.3)); return s; }
  const all = new Int16Array(total);
  let o = 0;
  for (const a of outs) { all.set(a, o); o += a.length; }
  return all;
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  try {
    if (msg.type === 'init') {
      await init();
      postMessage({ type: 'ready', id: msg.id });
    } else if (msg.type === 'synth') {
      await init();
      const t0 = Date.now();
      const pcm = synth(String(msg.text || ''), msg.speed);
      postMessage({ type: 'audio', id: msg.id, pcm, sampleRate: OUT_RATE, ms: Date.now() - t0 }, [pcm.buffer]);
    } else if (msg.type === 'g2p') {
      await init();
      postMessage({ type: 'g2p', id: msg.id, kana: ojt.g2p(String(msg.text || ''), true) });
    }
  } catch (e) {
    postMessage({ type: 'error', id: msg.id, error: (e && e.message) || String(e) });
  }
};
