// Preload: expose a small, safe file-read bridge for the sampler renderer.
const { contextBridge } = require('electron');
const fs = require('fs').promises;
const path = require('path');

const base = path.join(__dirname, '..', 'default', 'sampler');

async function safeReadJSON(relPath) {
  const p = path.join(base, relPath.replace(/^\.\//, ''));
  const s = await fs.readFile(p, 'utf8');
  return JSON.parse(s);
}

async function safeReadFileBuffer(relPath) {
  const p = path.join(base, relPath.replace(/^\.\//, ''));
  const buf = await fs.readFile(p);
  // Convert Node Buffer -> ArrayBuffer for structured clone across contextBridge
  const uint8 = Uint8Array.from(buf);
  return uint8.buffer;
}

contextBridge.exposeInMainWorld('koalaBridge', {
  readJSON: safeReadJSON,
  readFileBuffer: safeReadFileBuffer
});
