#!/usr/bin/env node
/**
 * Simple build script to copy the sampler web UI into a distributable folder.
 * Produces ../dist containing HTML, CSS, JS, JSON, and sample assets.
 */

const fs = require('fs/promises');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const samplerSrc = path.join(projectRoot, 'default', 'sampler');
const distDir = path.join(projectRoot, 'dist');

async function emptyDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}

async function copyRecursive(src, dest) {
  const stats = await fs.stat(src);
  if (stats.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await copyRecursive(from, to);
      } else {
        await fs.copyFile(from, to);
      }
    }
    return;
  }
  await fs.copyFile(src, dest);
}

(async () => {
  console.log('Building sampler distribution...');
  await emptyDir(distDir);
  await copyRecursive(samplerSrc, distDir);
  console.log('Build complete:', distDir);
})().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
