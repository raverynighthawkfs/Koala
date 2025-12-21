const grid = document.getElementById('grid');
const meta = document.getElementById('meta');
const btnStopAll = document.getElementById('stopAll');
const btnResume = document.getElementById('resumeAudio');
const sampleDrawer = document.getElementById('sampleDrawer');
const btnOpenSampleDrawer = document.getElementById('openSampleDrawer');
const btnCloseSampleDrawer = document.getElementById('closeSampleDrawer');
const drawerHandle = document.getElementById('drawerHandle');
const pianoOverlay = document.getElementById('pianoOverlay');
const btnPianoMode = document.getElementById('pianoMode');
const btnClosePianoOverlay = document.getElementById('closePianoOverlay');
const pianoKeysEl = document.getElementById('pianoKeys');
const scaleModeSelect = document.getElementById('scaleMode');
const vuWindow = document.getElementById('vuWindow');

// WebAudio
const audio = new (window.AudioContext || window.webkitAudioContext)();

// Cache decoded audio buffers by sampleId
const bufferCache = new Map();

// Sample metadata lookup (populated from sampler.json)
const sampleMetaById = new Map();

// Active nodes per pad: padIndex -> { src, gain, pan }
const activeByPad = new Map();

let selectedPadIndex = null;
const padKeyHints = ['1','2','3','4','Q','W','E','R','A','S','D','F','Z','X','C','V'];

function sampleUrl(sampleId) {
  return `./${sampleId}.wav`;
}

async function ensureAudioRunning() {
  if (audio.state !== 'running') await audio.resume();
}

async function loadState() {
  if (window.koalaBridge && typeof window.koalaBridge.readJSON === 'function') {
    return await window.koalaBridge.readJSON('./sampler.json');
  }

  const res = await fetch('./sampler.json');
  if (!res.ok) throw new Error(`Failed to load sampler.json (${res.status})`);
  return res.json();
}

// decode helper with fallback for older APIs
function decodeAudio(ab) {
  try {
    const maybe = audio.decodeAudioData(ab);
    if (maybe && typeof maybe.then === 'function') return maybe;
  } catch (e) {
    // ignore — try callback-style below
  }
  return new Promise((resolve, reject) => audio.decodeAudioData(ab, resolve, reject));
}

async function getBuffer(sampleId) {
  if (bufferCache.has(sampleId)) return bufferCache.get(sampleId);
  const url = sampleUrl(sampleId);

  let ab;
  if (window.koalaBridge && typeof window.koalaBridge.readFileBuffer === 'function') {
    ab = await window.koalaBridge.readFileBuffer(`${sampleId}.wav`);
  } else {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Missing sampleId=${sampleId} at ${url}`);
    ab = await res.arrayBuffer();
  }

  const buf = await decodeAudio(ab);
  bufferCache.set(sampleId, buf);
  return buf;
}

// Return an AudioBuffer optionally reversed (creates a new buffer)
async function getPlayableBuffer(sampleId, reverse) {
  const buf = await getBuffer(sampleId);
  if (!reverse) return buf;

  const channels = buf.numberOfChannels;
  const out = audio.createBuffer(channels, buf.length, buf.sampleRate);
  for (let c = 0; c < channels; c++) {
    const id = buf.getChannelData(c);
    const od = out.getChannelData(c);
    for (let i = 0, j = buf.length - 1; i < buf.length; i++, j--) od[i] = id[j];
  }
  return out;
}

function stopPad(padIndex) {
  const nodes = activeByPad.get(padIndex);
  if (!nodes) return;
  try { nodes.src.stop(); } catch {}
  activeByPad.delete(padIndex);
}

function stopAll() {
  for (const padIndex of Array.from(activeByPad.keys())) stopPad(padIndex);
  meta.textContent = 'Stopped all pads.';
}

function connectSimpleChain(src, padConfig) {
  const gain = audio.createGain();
  gain.gain.value = Number(padConfig?.vol ?? 1.0);

  const pan = audio.createStereoPanner();
  pan.pan.value = Number(padConfig?.pan ?? 0) || 0;

  src.connect(gain).connect(pan).connect(audio.destination);
  return { gain, pan };
}

let pads = new Map();
let allSampleIds = [];

function ensurePadExists(padIndex) {
  if (pads.has(padIndex)) return pads.get(padIndex);
  const empty = { pad: padIndex, sampleId: null, vol: 1, pitch: 0, pan: 0, oneshot: false, looping: false, reverse: false };
  pads.set(padIndex, empty);
  return empty;
}

function sampleLabel(sampleId) {
  if (sampleId == null) return 'empty';
  const meta = sampleMetaById.get(Number(sampleId));
  if (!meta) return `sampleId ${sampleId}`;
  const path = meta.originalPath || '';
  const last = path.split(/[\\/]/).filter(Boolean).pop();
  return last || `sampleId ${sampleId}`;
}

function updatePadButtonLabel(padIndex) {
  const btn = grid?.children?.[padIndex];
  const pad = pads.get(padIndex);
  if (!btn || !pad) return;
  const sub = btn.querySelector('.padSub');
  if (sub) sub.textContent = sampleLabel(pad.sampleId);
}

function pingVuActivity() {
  if (!vuWindow) return;
  vuWindow.classList.add('active');
  if (vuTimeout) clearTimeout(vuTimeout);
  vuTimeout = setTimeout(() => vuWindow.classList.remove('active'), 5000);
}

function setSampleDrawer(open) {
  if (!sampleDrawer) return;
  sampleDrawer.classList.toggle('open', open);
  sampleDrawer.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open && drawerTimer) { clearTimeout(drawerTimer); drawerTimer = null; }
}

function setPianoOverlay(open) {
  if (!pianoOverlay) return;
  pianoOverlay.classList.toggle('open', open);
  pianoOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (open && pianoTimer) { clearTimeout(pianoTimer); pianoTimer = null; }
}

function noteIndexFromName(name) {
  const match = name.match(/^([A-G])(#?)(\d)$/);
  if (!match) return 0;
  const baseOrder = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const note = match[1] + (match[2] || '');
  const octave = Number(match[3]);
  const semitone = baseOrder.indexOf(note);
  return octave * 12 + semitone;
}

function buildPiano(scale = 'chromatic') {
  if (!pianoKeysEl) return;
  pianoKeysEl.innerHTML = '';
  const allowed = new Set(scales[scale] || scales.chromatic);
  notesLayout.forEach((note, idx) => {
    const el = document.createElement('div');
    el.className = 'piano-key' + (note.black ? ' black' : '');
    const semitone = noteIndexFromName(note.name) % 12;
    el.dataset.note = note.name;
    el.dataset.pad = String(idx % 16);
    if (allowed.has(semitone)) {
      el.addEventListener('click', async () => {
        const padIndex = idx % 16;
        const padConfig = pads.get(padIndex) ?? ensurePadExists(padIndex);
        selectPadButton(padIndex);
        showPadDetails(padIndex);
        el.classList.add('active');
        setTimeout(() => el.classList.remove('active'), 150);
        try { await playPad(padIndex, padConfig); } catch (err) { meta.textContent = `ERROR: ${err?.message ?? String(err)}`; }
      });
    } else {
      el.classList.add('disabled');
    }
    const label = document.createElement('div');
    label.className = 'note-label';
    label.textContent = note.name;
    el.appendChild(label);
    pianoKeysEl.appendChild(el);
  });
}

async function playPad(padIndex, padConfig) {
  if (!padConfig || padConfig.sampleId == null) {
    meta.textContent = 'Choose a sample for this pad first.';
    return;
  }
  await ensureAudioRunning();
  stopPad(padIndex);

  const sampleId = padConfig.sampleId;
  const buf = await getPlayableBuffer(sampleId, padConfig.reverse === true || padConfig.reverse === 'true');

  const src = audio.createBufferSource();
  src.buffer = buf;
  src.loop = (padConfig.looping === true || padConfig.looping === 'true');
  // oneshot disables looping
  if (padConfig.oneshot === true || padConfig.oneshot === 'true') src.loop = false;

  // pitch in semitones -> playbackRate
  const pitch = Number(padConfig.pitch ?? 0) || 0;
  src.playbackRate.value = Math.pow(2, pitch / 12);

  const nodes = connectSimpleChain(src, padConfig);

  src.onended = () => {
    const cur = activeByPad.get(padIndex);
    if (cur && cur.src === src) activeByPad.delete(padIndex);
  };

  activeByPad.set(padIndex, { src, gain: nodes.gain, pan: nodes.pan });
  src.start();
  pingVuActivity();
  meta.textContent = `Pad ${padIndex} ▶ ${sampleLabel(sampleId)} | vol ${Number(padConfig.vol ?? 1).toFixed(2)} | pitch ${Number(padConfig.pitch ?? 0)} st | pan ${Number(padConfig.pan ?? 0)}`;
}

function clearSelected() {
  for (const b of grid.querySelectorAll('button.pad')) b.setAttribute('aria-selected', 'false');
}

function selectPadButton(padIndex) {
  const buttons = grid.querySelectorAll('button.pad');
  buttons.forEach(b => b.setAttribute('aria-selected', 'false'));
  const btn = buttons[padIndex];
  if (btn) btn.setAttribute('aria-selected', 'true');
}

function makePadButton(i, padConfig) {
  const b = document.createElement('button');
  b.className = 'pad';
  b.type = 'button';
  b.setAttribute('aria-selected', 'false');

  const top = document.createElement('div');
  top.className = 'padTop';
  const keyLabel = padKeyHints[i] ? ` (${padKeyHints[i]})` : '';
  top.textContent = `Pad ${i + 1}${keyLabel}`;

  const sub = document.createElement('div');
  sub.className = 'padSub';
  sub.textContent = padConfig ? sampleLabel(padConfig.sampleId) : 'empty';

  b.append(top, sub);

  b.addEventListener('click', async () => {
    try {
      clearSelected();
      b.setAttribute('aria-selected', 'true');
      showPadDetails(i);
      await playPad(i, padConfig);
    } catch (err) {
      meta.textContent = `ERROR: ${err?.message ?? String(err)}`;
      console.error(err);
    }
  });

  return b;
}

(async function boot() {
  try {
    const state = await loadState();
    pads = new Map(state.pads.map(p => [Number(p.pad), p]));
    // hydrate sample metadata
    (state.samples || []).forEach(s => sampleMetaById.set(Number(s.id), s.metadata || {}));
    allSampleIds = Array.from(new Set((state.samples || []).map(s => Number(s.id)))).sort((a,b)=>a-b);

    // create empty pad entries so the UI can assign samples to blank pads
    for (let i = 0; i < 16; i++) ensurePadExists(i);

    grid.innerHTML = '';
    for (let i = 0; i < 16; i++) grid.appendChild(makePadButton(i, pads.get(i) ?? null));

    // render sample tank
    const sampleIds = new Set(state.pads.map(p => p.sampleId).filter(Boolean));
    if (!allSampleIds.length) allSampleIds = Array.from(sampleIds);
    const listIds = Array.from(new Set([...(allSampleIds || []), ...sampleIds]));
    renderSampleList(listIds);

    meta.textContent = 'Ready.';
  } catch (err) {
    meta.textContent = `ERROR: ${err?.message ?? String(err)}`;
    throw err;
  }
})();

// UI elements
const waveformCanvas = document.getElementById('waveform');
const waveCtx = waveformCanvas && waveformCanvas.getContext ? waveformCanvas.getContext('2d') : null;
const btnOneShot = document.getElementById('oneShot');
const btnReverse = document.getElementById('reverse');
const btnLoop = document.getElementById('loop');
const btnPrev = document.getElementById('prevSample');
const btnNext = document.getElementById('nextSample');
const inputVol = document.getElementById('vol');
const inputPitch = document.getElementById('pitch');
const inputPan = document.getElementById('pan');
const sampleListEl = document.getElementById('sampleList');
const vuWindow = document.getElementById('vuWindow');
let vuTimeout = null;
let drawerTimer = null;
let pianoTimer = null;
const notesLayout = [
  { name: 'C2', black: false }, { name: 'C#2', black: true }, { name: 'D2', black: false }, { name: 'D#2', black: true }, { name: 'E2', black: false }, { name: 'F2', black: false }, { name: 'F#2', black: true }, { name: 'G2', black: false }, { name: 'G#2', black: true }, { name: 'A2', black: false }, { name: 'A#2', black: true }, { name: 'B2', black: false },
  { name: 'C3', black: false }, { name: 'C#3', black: true }, { name: 'D3', black: false }, { name: 'D#3', black: true }, { name: 'E3', black: false }, { name: 'F3', black: false }, { name: 'F#3', black: true }, { name: 'G3', black: false }, { name: 'G#3', black: true }, { name: 'A3', black: false }, { name: 'A#3', black: true }, { name: 'B3', black: false }
];
const scales = {
  'chromatic':    [0,1,2,3,4,5,6,7,8,9,10,11],
  'major':        [0,2,4,5,7,9,11],
  'minor':        [0,2,3,5,7,8,10],
  'harmonic-minor':[0,2,3,5,7,8,11],
  'pentatonic':   [0,2,4,7,9],
  'whole-tone':   [0,2,4,6,8,10]
};

function drawWaveform(buffer, canvas = waveformCanvas) {
  if (!buffer || !waveCtx || !canvas) return;
  const ctx = waveCtx;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0,0,w,h);
  ctx.fillStyle = 'rgba(20,190,255,0.06)';
  ctx.fillRect(0,0,w,h);
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#00e5ff';
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const idx = i * step;
    const v = data[idx] || 0;
    const y = (1 - (v + 1) / 2) * h;
    if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  }
  ctx.stroke();
}

function cycleSample(delta) {
  if (selectedPadIndex == null || !allSampleIds.length) return;
  const pad = ensurePadExists(selectedPadIndex);
  const currentId = pad.sampleId == null ? allSampleIds[0] : Number(pad.sampleId);
  const curIdx = Math.max(0, allSampleIds.indexOf(currentId));
  const nextIdx = (curIdx + delta + allSampleIds.length) % allSampleIds.length;
  pad.sampleId = allSampleIds[nextIdx];
  updatePadButtonLabel(selectedPadIndex);
  showPadDetails(selectedPadIndex);
}

async function showPadDetails(padIndex) {
  selectedPadIndex = padIndex;
  const pad = pads.get(padIndex) ?? null;
  if (!pad) {
    meta.textContent = 'Empty pad.';
    return;
  }
  if (pad.sampleId == null) {
    meta.textContent = `Pad ${padIndex} — no sample selected. Pick one from the Sample Tank.`;
    if (waveCtx) waveCtx.clearRect(0,0,waveformCanvas.width,waveformCanvas.height);
    return;
  }
  // update controls from pad
  inputVol.value = Number(pad.vol ?? 1);
  inputPitch.value = Number(pad.pitch ?? 0);
  inputPan.value = Number(pad.pan ?? 0);
  btnOneShot.classList.toggle('mdui-btn-active', pad.oneshot === true || pad.oneshot === 'true');
  btnReverse.classList.toggle('mdui-btn-active', pad.reverse === true || pad.reverse === 'true');
  btnLoop.classList.toggle('mdui-btn-active', pad.looping === true || pad.looping === 'true');

  try {
    const buf = await getBuffer(pad.sampleId);
    drawWaveform(buf);
    meta.textContent = `Pad ${padIndex} — ${sampleLabel(pad.sampleId)}`;
  } catch (err) {
    meta.textContent = `ERROR: ${err?.message ?? String(err)}`;
  }
}

// render sample list thumbnails
async function renderSampleList(sampleIds) {
  if (!sampleListEl) return;
  sampleListEl.innerHTML = '';
  const ids = (sampleIds && sampleIds.length ? sampleIds : allSampleIds);
  for (const sid of ids) {
    const c = document.createElement('canvas');
    c.width = 72; c.height = 24; c.style.width = '100%'; c.style.height = 'auto';
    c.dataset.sampleId = sid;
    const wrap = document.createElement('div');
    wrap.style.cursor = 'pointer';
    wrap.style.borderRadius = '6px';
    wrap.style.overflow = 'hidden';
    wrap.style.background = 'rgba(0,0,0,0.06)';
    wrap.appendChild(c);
    const label = document.createElement('div');
    label.className = 'sampleLabel';
    label.textContent = sampleLabel(sid);
    label.style.fontSize = '11px';
    label.style.padding = '4px 6px 6px';
    label.style.color = 'rgba(255,255,255,0.8)';
    wrap.appendChild(label);
    sampleListEl.appendChild(wrap);
    try {
      const buf = await getBuffer(sid);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#002b2f'; ctx.fillRect(0,0,c.width,c.height);
      ctx.strokeStyle = '#00e5ff'; ctx.beginPath();
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / c.width));
      for (let i=0;i<c.width;i++){ const v = data[i*step]||0; const y = (1-(v+1)/2)*c.height; if(i===0)ctx.moveTo(i,y);else ctx.lineTo(i,y);} ctx.stroke();
    } catch (err) {
      // ignore
    }
    wrap.addEventListener('click', () => {
      // assign to selected pad if any
      if (selectedPadIndex == null) return;
      const pad = ensurePadExists(selectedPadIndex);
      pad.sampleId = Number(c.dataset.sampleid || c.dataset.sampleId || sid);
      // update pad button label
      const btns = document.querySelectorAll('button.pad');
      const b = btns[selectedPadIndex];
      if (b) b.querySelector('.padSub').textContent = sampleLabel(pad.sampleId);
      showPadDetails(selectedPadIndex);
    });
  }
}

// wire UI interaction
if (grid) {
  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button.pad');
    if (!btn) return;
    const idx = Array.from(grid.children).indexOf(btn);
    if (idx >= 0) showPadDetails(idx);
  });
}

if (btnOneShot) btnOneShot.addEventListener('click', () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.oneshot = !(pad.oneshot === true || pad.oneshot === 'true');
  btnOneShot.classList.toggle('mdui-btn-active');
});
if (btnReverse) btnReverse.addEventListener('click', async () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.reverse = !(pad.reverse === true || pad.reverse === 'true');
  btnReverse.classList.toggle('mdui-btn-active');
  // redraw waveform reversed if toggled
  try { const buf = await getBuffer(pad.sampleId); drawWaveform(pad.reverse ? await getPlayableBuffer(pad.sampleId, true) : buf); } catch (e) {}
});
if (btnLoop) btnLoop.addEventListener('click', () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.looping = !(pad.looping === true || pad.looping === 'true');
  btnLoop.classList.toggle('mdui-btn-active');
});

if (inputVol) inputVol.addEventListener('input', () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.vol = Number(inputVol.value);
  const nodes = activeByPad.get(selectedPadIndex);
  if (nodes && nodes.gain) nodes.gain.gain.value = pad.vol;
});
if (inputPitch) inputPitch.addEventListener('input', () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.pitch = Number(inputPitch.value);
  const nodes = activeByPad.get(selectedPadIndex);
  if (nodes && nodes.src) nodes.src.playbackRate.value = Math.pow(2, pad.pitch/12);
});
if (inputPan) inputPan.addEventListener('input', () => {
  if (selectedPadIndex == null) return;
  const pad = ensurePadExists(selectedPadIndex);
  pad.pan = Number(inputPan.value);
  const nodes = activeByPad.get(selectedPadIndex);
  if (nodes && nodes.pan) nodes.pan.pan.value = pad.pan;
});

if (btnPrev) btnPrev.addEventListener('click', () => cycleSample(-1));
if (btnNext) btnNext.addEventListener('click', () => cycleSample(1));

// Controls
btnStopAll.addEventListener('click', stopAll);
btnResume.addEventListener('click', async () => {
  try {
    await ensureAudioRunning();
    meta.textContent = `AudioContext state: ${audio.state}`;
  } catch (err) {
    meta.textContent = `ERROR: ${err?.message ?? String(err)}`;
  }
});

if (btnOpenSampleDrawer) btnOpenSampleDrawer.addEventListener('click', () => setSampleDrawer(true));
if (btnCloseSampleDrawer) btnCloseSampleDrawer.addEventListener('click', () => setSampleDrawer(false));
if (drawerHandle) drawerHandle.addEventListener('click', () => setSampleDrawer(!sampleDrawer.classList.contains('open')));
window.addEventListener('keyup', (e) => {
  if (e.key === 'Escape') {
    setSampleDrawer(false);
    setPianoOverlay(false);
  }
});
if (btnPianoMode) btnPianoMode.addEventListener('click', () => { setPianoOverlay(true); buildPiano(scaleModeSelect?.value || 'chromatic'); });
if (btnClosePianoOverlay) btnClosePianoOverlay.addEventListener('click', () => setPianoOverlay(false));
if (scaleModeSelect) scaleModeSelect.addEventListener('change', () => buildPiano(scaleModeSelect.value));

// Keyboard map
const keyMap = new Map([
  ['1',0],['2',1],['3',2],['4',3],
  ['q',4],['w',5],['e',6],['r',7],
  ['a',8],['s',9],['d',10],['f',11],
  ['z',12],['x',13],['c',14],['v',15]
]);

window.addEventListener('keydown', async (e) => {
  if (e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); stopAll(); return; }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = (e.key || '').toLowerCase();
  if (!keyMap.has(k)) return;
  e.preventDefault();
  const padIndex = keyMap.get(k);
  const padConfig = pads.get(padIndex) ?? ensurePadExists(padIndex);
  selectPadButton(padIndex);
  showPadDetails(padIndex);
  try { await playPad(padIndex, padConfig); } catch (err) { meta.textContent = `ERROR: ${err?.message ?? String(err)}`; console.error(err); }
}, { capture: true });
