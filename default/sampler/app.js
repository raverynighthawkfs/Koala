const grid = document.getElementById('grid');
const meta = document.getElementById('meta');
const btnStopAll = document.getElementById('stopAll');
const btnResume = document.getElementById('resumeAudio');
const btnSequenceMode = document.getElementById('sequenceMode');
const sampleDrawer = document.getElementById('sampleDrawer');
const btnOpenSampleDrawer = document.getElementById('openSampleDrawer');
const btnCloseSampleDrawer = document.getElementById('closeSampleDrawer');
const drawerHandle = document.getElementById('drawerHandle');
const pianoOverlay = document.getElementById('pianoOverlay');
const btnPianoMode = document.getElementById('pianoMode');
const btnClosePianoOverlay = document.getElementById('closePianoOverlay');
const btnBackToSampler = document.getElementById('backToSampler');
const pianoKeysEl = document.getElementById('pianoKeys');
const scaleModeSelect = document.getElementById('scaleMode');
const octaveSelect = document.getElementById('octaveSelect');
const waveSelect = document.getElementById('waveSelect');
const vuWindow = document.getElementById('vuWindow');
const pianoVuWindow = document.getElementById('pianoVuWindow');
const pianoWaveformCanvas = document.getElementById('pianoWaveform');
const sequencerOverlay = document.getElementById('sequencerOverlay');
const seqPlayBtn = document.getElementById('seqPlay');
const seqStopBtn = document.getElementById('seqStop');
const seqMetroBtn = document.getElementById('seqMetro');
const seqBpmDisplay = document.getElementById('seqBpmDisplay');
const seqSlots = Array.from(document.querySelectorAll('.seq-slot'));
const seqGrid = document.getElementById('seqGrid');
const seqBarsSel = document.getElementById('seqBars');
const btnSeqToPiano = document.getElementById('seqToPiano');
const btnSeqUndo = document.getElementById('seqUndo');
const btnSeqClear = document.getElementById('seqClear');
const btnCloseSequencer = document.getElementById('closeSequencer');
const cssPiano = document.getElementById('cssPiano');
const cssPianoStatus = document.getElementById('cssPianoStatus');
const cssKeys = Array.from(document.querySelectorAll('.css-key'));
let cssPianoBound = false;
let toneStarted = false;
let toneSynth = null;
let toneCrusher = null;
let toneCompressor = null;
let toneDistortion = null;
let toneGain = null;
let currentInstrument = 'sampler'; // 'sampler' or 'piano'
let pianoWaveAnim = null;
let pianoWaveStop = 0;
const pianoWaveCtx = pianoWaveformCanvas && pianoWaveformCanvas.getContext ? pianoWaveformCanvas.getContext('2d') : null;
let sequenceState = null;
let currentSeqId = 0;

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
const knobFaces = document.querySelectorAll('.knob-face');

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
  try { nodes.src?.stop(); } catch {}
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

function pingPianoVu() {
  if (!pianoVuWindow) return;
  pianoVuWindow.classList.add('active');
  setTimeout(() => pianoVuWindow.classList.remove('active'), 5000);
}

function animatePianoWave(midiNote) {
  if (!pianoWaveCtx || !pianoWaveformCanvas) return;
  const ctx = pianoWaveCtx;
  const w = pianoWaveformCanvas.width;
  const h = pianoWaveformCanvas.height;
  pianoWaveStop = performance.now() + 5000;
  if (pianoWaveAnim) cancelAnimationFrame(pianoWaveAnim);

  const hue = 180 + (midiNote % 40);
  const draw = () => {
    const now = performance.now();
    if (now > pianoWaveStop) return;
    ctx.clearRect(0,0,w,h);
    const grad = ctx.createLinearGradient(0,0,w,h);
    grad.addColorStop(0, `rgba(0, ${120 + (midiNote%80)}, 180, 0.25)`);
    grad.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = grad;
    ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = `hsl(${hue},90%,60%)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    const freq = 4 + (midiNote % 6);
    for (let x = 0; x < w; x++) {
      const norm = x / w;
      const y = h/2 + Math.sin(norm * Math.PI * freq + now * 0.01) * h * 0.3 * Math.sin(now * 0.002);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    pianoWaveAnim = requestAnimationFrame(draw);
  };
  draw();
}

function renderSeqSlots(seqs = []) {
  if (!seqSlots.length) return;
  seqSlots.forEach((btn, idx) => {
    const s = seqs[idx];
    btn.textContent = s ? `SEQ ${idx+1}` : '+';
    btn.classList.toggle('active', idx === currentSeqId);
  });
}

function renderSeqGrid(seq) {
  if (!seqGrid) return;
  seqGrid.innerHTML = '';
  const cells = [];
  for (let r=0;r<8;r++){
    for (let c=0;c<8;c++){
      const cell = document.createElement('div');
      cell.className = 'seq-cell';
      cell.dataset.row = r;
      cell.dataset.col = c;
      cells.push(cell);
      seqGrid.appendChild(cell);
    }
  }
  if (!seq || !seq.noteSequence || !seq.noteSequence.pattern || !seq.noteSequence.pattern.notes) return;
  const notes = seq.noteSequence.pattern.notes;
  const total = Math.max(...notes.map(n => (n.timeOffset||0)+(n.length||0)), 1);
  notes.forEach(n => {
    const col = Math.min(7, Math.floor(((n.timeOffset||0)/total)*8));
    const row = Math.min(7, Math.max(0, 7 - ((n.num||0)%8)));
    const idx = row*8 + col;
    if (cells[idx]) cells[idx].classList.add('active');
  });
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
  if (!open) {
    Array.from(cssOscByKey.keys()).forEach(key => releaseCssNote(key));
    currentInstrument = 'sampler';
    stopPianoAudio();
    meta.textContent = 'Instrument: Sampler';
  }
}

function setSequencerOverlay(open) {
  if (!sequencerOverlay) return;
  sequencerOverlay.classList.toggle('open', open);
  sequencerOverlay.setAttribute('aria-hidden', open ? 'false' : 'true');
  if (!open) {
    currentInstrument = 'sampler';
  }
}

function setInstrument(mode = 'sampler') {
  if (mode === currentInstrument) return;
  if (mode === 'piano') {
    stopAll();
    currentInstrument = 'piano';
    bindCssPiano();
    setPianoOverlay(true);
    toggleCssPiano(true, 'Piano active — keys mapped.');
    meta.textContent = 'Instrument: Piano (Sampler paused)';
    setSequencerOverlay(false);
  } else {
    stopPianoAudio();
    currentInstrument = 'sampler';
    setPianoOverlay(false);
    setSequencerOverlay(false);
    meta.textContent = 'Instrument: Sampler (Piano paused)';
  }
}

function toggleCssPiano(show, message = '') {
  if (cssPiano) cssPiano.classList.toggle('is-active', !!show);
  if (cssPianoStatus) {
    cssPianoStatus.textContent = message || '';
    cssPianoStatus.classList.toggle('show', !!show && !!message);
  }
}

function flashCssStatus(message = '') {
  if (!cssPianoStatus || !message) return;
  cssPianoStatus.textContent = message;
  cssPianoStatus.classList.add('show');
  setTimeout(() => cssPianoStatus.classList.remove('show'), 2000);
}

function ensureCssPianoMounted() {
  if (!pianoKeysEl || !cssPiano) return;
  if (!pianoKeysEl.contains(cssPiano)) pianoKeysEl.appendChild(cssPiano);
}

function midiFromNoteName(note = 'C', octave = 4) {
  const semis = { 'C':0,'C#':1,'D':2,'D#':3,'E':4,'F':5,'F#':6,'G':7,'G#':8,'A':9,'A#':10,'B':11 };
  const semi = semis[note] ?? 0;
  return (octave + 1) * 12 + semi;
}

function freqFromMidi(midiNote) {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

function assignCssPianoNotes() {
  if (!cssKeys.length) return;
  const baseOct = Number(octaveSelect?.value || 4);
  const whiteKeys = cssKeys.filter(k => k.classList.contains('white'));
  const blackKeys = cssKeys.filter(k => k.classList.contains('black'));
  const whiteSeq = ['C','D','E','F','G','A','B'];
  const blackSeq = ['C#','D#','F#','G#','A#'];
  whiteKeys.forEach((key, idx) => {
    const note = whiteSeq[idx % whiteSeq.length];
    const octave = baseOct + Math.floor(idx / whiteSeq.length);
    const midi = midiFromNoteName(note, octave);
    key.dataset.midi = midi;
    key.dataset.noteFull = `${note}${octave}`;
  });
  // build black notes list based on octave groups (5 blacks per octave)
  const blackNotes = [];
  for (let oct = 0; blackNotes.length < blackKeys.length; oct++) {
    blackSeq.forEach(n => {
      if (blackNotes.length < blackKeys.length) {
        blackNotes.push({ note: n, octave: baseOct + oct });
      }
    });
  }
  blackKeys.forEach((key, idx) => {
    const entry = blackNotes[idx] || { note: 'C#', octave: baseOct };
    const midi = midiFromNoteName(entry.note, entry.octave);
    key.dataset.midi = midi;
    key.dataset.noteFull = `${entry.note}${entry.octave}`;
  });
}

function releaseCssNote(keyEl) {
  if (!keyEl) return;
  keyEl.classList.remove('is-playing');
  const osc = cssOscByKey.get(keyEl);
  if (!osc) return;
  try {
    osc.gain.gain.cancelScheduledValues(audio.currentTime);
    osc.gain.gain.setTargetAtTime(0, audio.currentTime, 0.06);
    osc.osc.stop(audio.currentTime + 0.12);
  } catch {}
  cssOscByKey.delete(keyEl);
}

function stopPianoAudio() {
  Array.from(cssOscByKey.keys()).forEach(key => releaseCssNote(key));
  try { toneSynth?.releaseAll?.(); } catch {}
}

async function ensureToneChain() {
  if (!window.Tone) return null;
  if (!toneStarted) {
    try { await Tone.start(); toneStarted = true; } catch (err) { console.error(err); return null; }
  }
  if (!toneCrusher || !toneCompressor || !toneDistortion || !toneGain || !toneSynth) {
    toneCrusher = new Tone.BitCrusher(4);
    toneDistortion = new Tone.Distortion(0);
    toneCompressor = new Tone.Compressor({ threshold: -24, ratio: 4, attack: 0.01, release: 0.25 });
    toneGain = new Tone.Gain(0.8);
    toneSynth = new Tone.PolySynth(Tone.Synth, { oscillator: { type: waveSelect?.value || 'triangle' } });
    toneSynth.chain(toneCrusher, toneDistortion, toneCompressor, toneGain, Tone.Destination);
  } else if (waveSelect) {
    toneSynth.set({ oscillator: { type: waveSelect.value } });
  }
  return toneSynth;
}

function applyPianoControl(param, val) {
  ensureToneChain();
  const pct = val / 127;
  switch(param) {
    case 'volume':
      if (toneGain) toneGain.gain.value = pct;
      break;
    case 'power':
      if (toneGain) toneGain.gain.value = Math.max(0, pct * 1.1);
      break;
    case 'limiter':
      if (toneCompressor) toneCompressor.threshold.value = -60 + pct * 40; // -60dB to -20dB
      break;
    case 'crunch':
      if (toneCrusher) toneCrusher.bits = Math.max(1, Math.round(1 + pct * 7));
      break;
    case 'distortion':
      if (toneDistortion) toneDistortion.distortion = Math.min(1, pct);
      break;
    default:
      break;
  }
}

async function playCssNote(keyEl) {
  if (!keyEl) return;
  await ensureAudioRunning();
  const midiNote = Number(keyEl.dataset.midi || 60);
  keyEl.classList.add('is-playing');
  const synth = await ensureToneChain();
  if (synth) {
    synth.triggerAttackRelease(Tone.Frequency(midiNote, 'midi'), '8n');
    flashCssStatus(keyEl.dataset.noteFull || 'Key');
    setTimeout(() => releaseCssNote(keyEl), 300);
    pingPianoVu();
    animatePianoWave(midiNote);
    return;
  }
  // fallback to raw WebAudio if Tone is unavailable
  const freq = freqFromMidi(midiNote);
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  osc.type = waveSelect?.value || 'triangle';
  gain.gain.value = 0;
  osc.connect(gain).connect(audio.destination);
  const now = audio.currentTime;
  gain.gain.linearRampToValueAtTime(0.32, now + 0.02);
  gain.gain.setTargetAtTime(0.12, now + 0.12, 0.08);
  osc.start(now);
  cssOscByKey.set(keyEl, { osc, gain });
  flashCssStatus(keyEl.dataset.noteFull || 'Key');
  pingPianoVu();
  animatePianoWave(midiNote);
  setTimeout(() => releaseCssNote(keyEl), 400);
}

function bindCssPiano() {
  if (cssPianoBound) return;
  cssPianoBound = true;
  ensureCssPianoMounted();
  assignCssPianoNotes();
  cssKeys.forEach(key => {
    key.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      playCssNote(key);
    });
    key.addEventListener('pointerup', () => releaseCssNote(key));
    key.addEventListener('pointerleave', () => releaseCssNote(key));
    key.addEventListener('pointercancel', () => releaseCssNote(key));
    key.addEventListener('touchstart', (e) => {
      e.preventDefault();
      playCssNote(key);
    }, { passive: false });
    key.addEventListener('touchend', () => releaseCssNote(key));
  });
}

const cssOscByKey = new Map();

async function playPad(padIndex, padConfig) {
  if (!padConfig || padConfig.sampleId == null) {
    meta.textContent = 'Choose a sample for this pad first.';
    return;
  }
  await ensureAudioRunning();
  stopPad(padIndex);

  const sampleId = padConfig.sampleId;
  const pitch = Number(padConfig.pitch ?? 0) || 0;
  const looping = (padConfig.looping === true || padConfig.looping === 'true') && !(padConfig.oneshot === true || padConfig.oneshot === 'true');

  const buf = await getPlayableBuffer(sampleId, padConfig.reverse === true || padConfig.reverse === 'true');
  const src = audio.createBufferSource();
  src.buffer = buf;
  src.loop = looping;
  src.playbackRate.value = Math.pow(2, pitch / 12);
  const nodes = connectSimpleChain(src, padConfig);
  src.onended = () => {
    const cur = activeByPad.get(padIndex);
    if (cur && cur.src === src) activeByPad.delete(padIndex);
  };
  activeByPad.set(padIndex, { src, gain: nodes.gain, pan: nodes.pan });
  src.start();
  pingVuActivity();
  meta.textContent = `Pad ${padIndex} ▶ ${sampleLabel(sampleId)} | vol ${Number(padConfig.vol ?? 1).toFixed(2)} | pitch ${pitch} st | pan ${Number(padConfig.pan ?? 0)}`;
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
   // placeholder block for pad name
  const blocker = document.createElement('div');
  blocker.className = 'padNameBlock';
  blocker.textContent = sub.textContent;

  b.append(top, sub, blocker);

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
    currentInstrument = 'sampler';

    // load sequencer state
    try {
      const res = await fetch('./sequence.json');
      if (res.ok) {
        sequenceState = await res.json();
        seqBpmDisplay.textContent = sequenceState.bpm || 120;
        currentSeqId = sequenceState.currSequenceId || 0;
        renderSeqSlots(sequenceState.sequences || []);
        renderSeqGrid(sequenceState.sequences?.[currentSeqId]);
      }
    } catch (err) {
      console.warn('Failed to load sequence.json', err);
    }
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
    c.width = 200; c.height = 64; c.style.width = '100%'; c.style.height = 'auto';
    c.dataset.sampleId = sid;
    const wrap = document.createElement('div');
    wrap.className = 'sampleCard';
    wrap.style.cursor = 'pointer';
    wrap.appendChild(c);
    const label = document.createElement('div');
    label.className = 'sampleLabel';
    label.textContent = sampleLabel(sid);
    sampleListEl.appendChild(wrap);
    try {
      const buf = await getBuffer(sid);
      const ctx = c.getContext('2d');
      ctx.fillStyle = 'rgba(0,20,20,0.9)';
      ctx.fillRect(0,0,c.width,c.height);
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / c.width));
      for (let i=0;i<c.width;i++){
        const v = data[i*step]||0;
        const y = (1-(v+1)/2)*c.height;
        if(i===0)ctx.moveTo(i,y);else ctx.lineTo(i,y);
      }
      ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = 'rgba(0,255,180,0.2)';
      ctx.fillRect(0, c.height/2, c.width, 1);
      ctx.globalAlpha = 1;
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
    setSequencerOverlay(false);
  }
});
if (btnPianoMode) btnPianoMode.addEventListener('click', () => { setInstrument('piano'); });
if (btnClosePianoOverlay) btnClosePianoOverlay.addEventListener('click', () => setPianoOverlay(false));
if (scaleModeSelect) scaleModeSelect.addEventListener('change', () => flashCssStatus(`Scale: ${scaleModeSelect.value}`));
if (octaveSelect) octaveSelect.addEventListener('change', () => { assignCssPianoNotes(); flashCssStatus(`Octave ${octaveSelect.value}`); });
if (waveSelect) waveSelect.addEventListener('change', () => { flashCssStatus(`Wave ${waveSelect.value}`); });
if (btnBackToSampler) btnBackToSampler.addEventListener('click', () => { setInstrument('sampler'); });
if (btnSequenceMode) btnSequenceMode.addEventListener('click', () => { stopAll(); setSequencerOverlay(true); currentInstrument = 'sequencer'; });
if (btnCloseSequencer) btnCloseSequencer.addEventListener('click', () => setSequencerOverlay(false));
if (seqSlots.length) seqSlots.forEach((btn, idx) => btn.addEventListener('click', () => { currentSeqId = idx; renderSeqSlots(sequenceState?.sequences || []); renderSeqGrid(sequenceState?.sequences?.[idx]); }));
if (btnSeqToPiano) btnSeqToPiano.addEventListener('click', () => setInstrument('piano'));

function setKnobValue(el, value) {
  const clamped = Math.max(0, Math.min(127, value));
  const deg = -120 + (clamped / 127) * 240;
  el.style.setProperty('--knob-deg', `${deg}deg`);
  el.dataset.val = clamped;
  const param = el.dataset.param;
  applyPianoControl(param, clamped);
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
  if (e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); stopAll(); return; }
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = (e.key || '').toLowerCase();
  if (!keyMap.has(k)) return;
  e.preventDefault();
  if (currentInstrument === 'piano') {
    const idx = keyMap.get(k) % cssKeys.length;
    const keyEl = cssKeys[idx];
    if (keyEl) playCssNote(keyEl);
    return;
  }
  const padIndex = keyMap.get(k);
  const padConfig = pads.get(padIndex) ?? ensurePadExists(padIndex);
  selectPadButton(padIndex);
  showPadDetails(padIndex);
  try { await playPad(padIndex, padConfig); } catch (err) { meta.textContent = `ERROR: ${err?.message ?? String(err)}`; console.error(err); }
}, { capture: true });
