#!/usr/bin/env node
// Prints a Markdown table with the built size of every package (raw and gzip),
// so pull requests show how a change moves the Worker bundle.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = new URL('../packages/', import.meta.url).pathname;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(m?js|cjs)$/.test(entry.name) && !entry.name.endsWith('.map')) out.push(full);
  }
  return out;
}

function kb(n) {
  return `${(n / 1024).toFixed(1)} kB`;
}

const rows = [];
for (const pkg of readdirSync(root)) {
  const dist = join(root, pkg, 'dist');
  let files = [];
  try {
    if (statSync(dist).isDirectory()) files = walk(dist);
  } catch {
    continue;
  }
  let raw = 0;
  let gz = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    raw += buf.length;
    gz += gzipSync(buf, { level: 9 }).length;
  }
  rows.push([pkg, files.length, raw, gz]);
}

rows.sort((a, b) => b[3] - a[3]);
console.log('### Package sizes\n');
console.log('| Package | Files | Raw | Gzip |');
console.log('| --- | ---: | ---: | ---: |');
for (const [pkg, n, raw, gz] of rows) console.log(`| \`${pkg}\` | ${n} | ${kb(raw)} | ${kb(gz)} |`);
const total = rows.reduce((s, r) => s + r[3], 0);
console.log(`\nTotal gzip across packages: **${kb(total)}**`);
