#!/usr/bin/env node
// Builds a Hypdriv release bundle: every publishable package packed to a tarball, checksums, the installer, the
// implementation guide with the docs, copy-paste templates extracted from that guide, the agent prompt and an optional
// private overlay (platform notes, generator patch). Hypdriv is not on npm; applications install from this folder.
//
//   pnpm build && node scripts/release-bundle.mjs [--out <dir>] [--date YYYY-MM-DD] [--overlay <dir>] [--force]
//
// Default output: release/out/hypdriv-<version>-<date>/ (git-ignored). A bundle is immutable: an existing output folder
// is an error unless --force replaces it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`release-bundle: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { out: null, date: new Date().toISOString().slice(0, 10), overlay: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} needs a value`);
    if (arg === '--out') options.out = resolve(value());
    else if (arg === '--date') options.date = value();
    else if (arg === '--overlay') options.overlay = resolve(value());
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/release-bundle.mjs [--out <dir>] [--date YYYY-MM-DD] [--overlay <dir>] [--force]',
      );
      process.exit(0);
    } else fail(`unknown option ${arg}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date)) fail(`--date must be YYYY-MM-DD, got ${options.date}`);
  return options;
}

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function publishablePackages() {
  const packages = [];
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, 'packages', entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    packages.push({ dir, name: pkg.name, version: pkg.version });
  }
  packages.sort((a, b) => a.name.localeCompare(b.name));
  return packages;
}

// The first fenced block of `lang` under the heading that starts with `heading`, up to the next heading.
function guideBlock(guide, heading, lang) {
  const lines = guide.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  if (start < 0) fail(`guide heading "${heading}" not found`);
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,3} /.test(lines[i])) break;
    if (lines[i].startsWith(`\`\`\`${lang}`)) {
      const body = [];
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('```'); j++) body.push(lines[j]);
      return `${body.join('\n')}\n`;
    }
  }
  return fail(`no \`\`\`${lang} block under guide heading "${heading}"`);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

const options = parseArgs(process.argv.slice(2));
const packages = publishablePackages();
if (packages.length === 0) fail('no publishable packages under packages/');
const versions = new Set(packages.map((p) => p.version));
if (versions.size !== 1) fail(`packages disagree on the version: ${[...versions].join(', ')}`);
const version = [...versions][0];

for (const pkg of packages) {
  if (!existsSync(join(pkg.dir, 'dist'))) fail(`${pkg.name} has no dist/: run \`pnpm build\` first`);
}

const out = options.out ?? join(root, 'release', 'out', `hypdriv-${version}-${options.date}`);
if (existsSync(out)) {
  if (!options.force) fail(`${out} exists; a bundle is immutable (use --force to replace it)`);
  rmSync(out, { recursive: true, force: true });
}
const tarballs = join(out, 'tarballs');
mkdirSync(tarballs, { recursive: true });

// 1. Pack. pnpm pack resolves workspace: and catalog: ranges to real versions.
for (const pkg of packages) {
  console.log(`pack ${pkg.name}`);
  execFileSync('pnpm', ['pack', '--pack-destination', tarballs], {
    cwd: pkg.dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
const packed = readdirSync(tarballs)
  .filter((f) => f.endsWith('.tgz'))
  .sort();
if (packed.length !== packages.length)
  fail(`packed ${packed.length} tarballs for ${packages.length} packages`);

// 2. The installer must find every tarball it installs.
copyFileSync(join(root, 'release', 'install.sh'), join(out, 'install.sh'));
chmodSync(join(out, 'install.sh'), 0o755);
const names =
  /NAMES=\(([^)]*)\)/
    .exec(readFileSync(join(out, 'install.sh'), 'utf8'))?.[1]
    .trim()
    .split(/\s+/) ?? [];
if (names.length === 0) fail('could not read NAMES from release/install.sh');
for (const file of [`hypdriv-${version}.tgz`, ...names.map((n) => `${n}-${version}.tgz`)]) {
  if (!packed.includes(file)) fail(`install.sh installs ${file}, which was not packed`);
}

// 3. VERSION and checksums (names relative to tarballs/, as install.sh verifies them).
writeFileSync(join(out, 'VERSION'), `${version}\n`);
writeFileSync(
  join(out, 'SHA256SUMS'),
  `${packed.map((f) => `${sha256(join(tarballs, f))}  ${f}`).join('\n')}\n`,
);

// 4. Docs, skill, agent guidance.
cpSync(join(root, 'docs'), join(out, 'docs'), { recursive: true });
cpSync(join(root, 'skills', 'hypdriv'), join(out, 'skills', 'hypdriv'), { recursive: true });
copyFileSync(join(root, 'AGENTS.md'), join(out, 'AGENTS.md'));
if (existsSync(join(root, 'LICENSE'))) copyFileSync(join(root, 'LICENSE'), join(out, 'LICENSE'));

// 5. Templates: the code blocks of the guide, so they cannot drift from it.
const guide = readFileSync(join(root, 'docs', 'guides', 'production-cloudflare.md'), 'utf8');
const templates = join(out, 'templates');
mkdirSync(templates, { recursive: true });
const extracted = [
  ['hypdriv.config.ts', '### 6.1 ', 'ts'],
  ['next.config.ts', '### 5.3 ', 'ts'],
  ['open-next.config.ts', '### 5.4 ', 'ts'],
  ['hypdriv.worker.ts', '### 5.5 ', 'ts'],
  ['wrangler.jsonc', '### 5.6 ', 'jsonc'],
];
for (const [file, heading, lang] of extracted)
  writeFileSync(join(templates, file), guideBlock(guide, heading, lang));
writeFileSync(
  join(templates, 'dev.vars.example'),
  '# Names only. Copy to .dev.vars (git-ignored) and give each a throwaway value of 32+ random bytes.\nHYPDRIV_SESSION_SECRET=\nHYPDRIV_INTERNAL_SECRET=\n',
);

// 6. README and the prompt for chats.
const dirty = git('status', '--porcelain') ? '+uncommitted' : '';
const commit = `${git('rev-parse', '--short', 'HEAD') || 'unknown'}${dirty}`;
const readme = readFileSync(join(root, 'release', 'BUNDLE-README.md'), 'utf8')
  .replaceAll('{{VERSION}}', version)
  .replaceAll('{{DATE}}', options.date)
  .replaceAll('{{COMMIT}}', commit)
  .replaceAll('{{TARBALLS}}', String(packed.length));
writeFileSync(join(out, 'README.md'), readme);
copyFileSync(join(root, 'release', 'PROMPT-FOR-CHATS.md'), join(out, 'PROMPT-FOR-CHATS.md'));

// 7. Private overlay (platform notes, generator patch). It adds files; it never replaces a generated one.
if (options.overlay) {
  if (!existsSync(options.overlay) || !statSync(options.overlay).isDirectory())
    fail(`overlay ${options.overlay} is not a directory`);
  for (const file of listFiles(options.overlay)) {
    const target = join(out, relative(options.overlay, file));
    if (existsSync(target))
      fail(`overlay file ${relative(options.overlay, file)} would replace a generated file`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(file, target);
  }
}

// 8. Summary.
const files = listFiles(out);
console.log(`\nbundle: ${out}`);
console.log(`version ${version}, date ${options.date}, commit ${commit}`);
console.log(
  `${packed.length} tarballs, ${files.length} files${options.overlay ? ', private overlay applied' : ''}`,
);
