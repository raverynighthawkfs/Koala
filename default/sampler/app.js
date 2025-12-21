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
const midiSystemSel = document.getElementById('midiSystem');
const bankMsbSel = document.getElementById('bankMsb');
const bankLsbSel = document.getElementById('bankLsb');
const programSelect = document.getElementById('programSelect');
const midiOutSelect = document.getElementById('midiOutSelect');
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
const notesLayout = [];
const pianoKeyMap = new Map();
const knobFaces = document.querySelectorAll('.knob-face');
const scales = {
  'chromatic':    [0,1,2,3,4,5,6,7,8,9,10,11],
  'major':        [0,2,4,5,7,9,11],
  'minor':        [0,2,3,5,7,8,10],
  'harmonic-minor':[0,2,3,5,7,8,11],
  'pentatonic':   [0,2,4,7,9],
  'whole-tone':   [0,2,4,6,8,10]
};

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

function ensureQwerty(scale = 'chromatic', force = false) {
  if (!pianoKeysEl || !window.JZZ || !JZZ.input || !JZZ.input.Qwerty) {
    console.warn('Qwerty keyboard unavailable (JZZ.input.Qwerty missing).');
    if (pianoKeysEl) pianoKeysEl.textContent = 'Keyboard unavailable — JZZ.input.Qwerty not loaded.';
    return;
  }
  if (force && qwertyInput) {
    try { qwertyInput.disconnect(); } catch {}
    qwertyInput = null;
  }
  // force dimensions so the responsive keyboard renders
  const w = Math.max(900, pianoKeysEl.clientWidth || Math.round(window.innerWidth * 0.9) || 900);
  const h = Math.max(360, pianoKeysEl.clientHeight || Math.round(window.innerHeight * 0.5) || 360);
  if (!qwertyInput) {
    pianoKeysEl.innerHTML = '';
    qwertyInput = JZZ.input.Qwerty({
      at: pianoKeysEl,
      w,
      h,
      from: 'C3',
      to: 'C5',
      ww: 48, // white key width
      wb: 32, // white key border radius
      bw: 32, // black key width
      bb: 24, // black key border radius
      color: '#0b1016',
      colorhi: '#0b1016',
      colorlo: '#0b1016',
      stroke: '#39ff14',
      hl: '#7dff5d',
      scale
    });
  }
  try {
    qwertyInput.disconnect();
    qwertyInput.connect(initMidi());
  } catch (err) {
    console.error(err);
  }
}

function buildPiano(scale = 'chromatic') {
  // rebuild after overlay is visible to get correct dimensions
  requestAnimationFrame(() => ensureQwerty(scale, true));
  // double-tap after paint in case dimensions were 0 on first pass
  setTimeout(() => ensureQwerty(scale, true), 120);
  setTimeout(() => ensureQwerty(scale, true), 260);
}

function initMidi() {
  if (midiOut) return midiOut;
  if (!window.JZZ) return null;
  try {
    // prefer OSC if available, fallback to Tiny
  if (currentOutType === 'osc' && window.JZZ.synth && window.JZZ.synth.OSC) {
    midiOut = window.JZZ.synth.OSC();
  } else if (window.JZZ.synth && window.JZZ.synth.Tiny) {
    midiOut = window.JZZ.synth.Tiny();
  } else {
    midiOut = window.JZZ().openMidiOut();
  }
  } catch (err) {
    console.error('MIDI init failed', err);
    midiOut = null;
  }
  return midiOut;
}

function sendProgramChange(program = 0, msb = 0, lsb = 0) {
  const out = initMidi();
  if (!out) return;
  try {
    out.control(0, 0, msb);
    out.control(0, 32, lsb);
    out.program(0, program);
    currentProgram = program;
    meta.textContent = `Program ${program}`;
  } catch (err) {
    console.error(err);
  }
}

function noteOn(noteNum, velocity = 100) {
  const out = initMidi();
  if (!out) return;
  try { out.noteOn(0, noteNum, velocity); } catch (err) { console.error(err); }
}
function noteOff(noteNum) {
  const out = initMidi();
  if (!out) return;
  try { out.noteOff(0, noteNum); } catch (err) { console.error(err); }
}

function resetMidiOut() {
  midiOut = null;
  initMidi();
  sendProgramChange(currentProgram, Number(bankMsbSel?.value || 0), Number(bankLsbSel?.value || 0));
  ensureQwerty(scaleModeSelect?.value || 'chromatic');
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
let vuTimeout = null;
let drawerTimer = null;
let pianoTimer = null;
let midiOut = null;
let currentProgram = 0;
let currentOutType = 'osc';
let qwertyInput = null;

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

const programOptions = [
  { value: 0, label: '00 Acoustic Grand Piano' },
  { value: 4, label: '04 Electric Piano 1' },
  { value: 16, label: '16 Drawbar Organ' },
  { value: 24, label: '24 Nylon Guitar' },
  { value: 32, label: '32 Acoustic Bass' },
  { value: 40, label: '40 Violin' },
  { value: 48, label: '48 Strings' },
  { value: 56, label: '56 Trumpet' },
  { value: 64, label: '64 Soprano Sax' },
  { value: 73, label: '73 Flute' },
  { value: 80, label: '80 Square Lead' },
  { value: 88, label: '88 New Age Pad' }
];

function hydrateProgramSelect() {
  if (!programSelect) return;
  programSelect.innerHTML = '';
  programOptions.forEach(opt => {
    const o = document.createElement('option');
    o.value = String(opt.value);
    o.textContent = opt.label;
    programSelect.appendChild(o);
  });
  programSelect.value = String(currentProgram);
}

hydrateProgramSelect();
if (programSelect) programSelect.addEventListener('change', () => {
  const p = Number(programSelect.value || 0);
  sendProgramChange(p, Number(bankMsb?.value || 0), Number(bankLsb?.value || 0));
});

if (midiOutSelect) midiOutSelect.addEventListener('change', () => { currentOutType = midiOutSelect.value; resetMidiOut(); });
if (bankMsbSel) bankMsbSel.addEventListener('change', () => sendProgramChange(Number(programSelect?.value || 0), Number(bankMsbSel.value || 0), Number(bankLsbSel?.value || 0)));
if (bankLsbSel) bankLsbSel.addEventListener('change', () => sendProgramChange(Number(programSelect?.value || 0), Number(bankMsbSel?.value || 0), Number(bankLsbSel.value || 0)));

const knobCcMap = {
  volume: 7,
  pan: 10,
  limiter: 91,
  crunch: 12,
  power: 13
};

function setKnobValue(el, value) {
  const clamped = Math.max(0, Math.min(127, value));
  const deg = -120 + (clamped / 127) * 240;
  el.style.setProperty('--knob-deg', `${deg}deg`);
  el.dataset.val = clamped;
  const param = el.dataset.param;
  const cc = knobCcMap[param];
  if (cc !== undefined) {
    const out = initMidi();
    try { out?.control(0, cc, clamped); } catch {}
  }
}

knobFaces.forEach(el => {
  let dragging = false;
  let startY = 0;
  let startVal = Number(el.dataset.val || 64);
  setKnobValue(el, startVal);
  const onMove = (e) => {
    if (!dragging) return;
    const dy = startY - (e.touches ? e.touches[0].clientY : e.clientY);
    const next = startVal + dy;
    setKnobValue(el, next);
  };
  const onUp = () => { dragging = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('touchmove', onMove); };
  el.addEventListener('mousedown', (e) => {
    dragging = true; startY = e.clientY; startVal = Number(el.dataset.val || 64);
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp, { once: true });
  });
  el.addEventListener('touchstart', (e) => {
    dragging = true; startY = e.touches[0].clientY; startVal = Number(el.dataset.val || 64);
    window.addEventListener('touchmove', onMove); window.addEventListener('touchend', onUp, { once: true });
  });
});

// Keyboard map
const keyMap = new Map([
  ['1',0],['2',1],['3',2],['4',3],
  ['q',4],['w',5],['e',6],['r',7],
  ['a',8],['s',9],['d',10],['f',11],
  ['z',12],['x',13],['c',14],['v',15]
]);

window.addEventListener('keydown', async (e) => {
  if (pianoOverlay && pianoOverlay.classList.contains('open') && qwertyInput) {
    // Let JZZ.input.Qwerty handle keystrokes
    return;
  }
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
