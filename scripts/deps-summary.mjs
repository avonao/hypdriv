#!/usr/bin/env node
// Turns the JSON report of `hypdriv deps --json` into Markdown for the CI step
// summary and for the pull-request body (deps-report.md).
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
let report;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch {
  report = { packages: [], generatedAt: new Date().toISOString() };
}

const bySeverity = { major: [], minor: [], patch: [] };
for (const p of report.packages ?? []) {
  for (const d of p.outdated ?? []) (bySeverity[d.diff] ?? bySeverity.patch).push({ ...d, package: p.name });
}

const lines = [];
lines.push(`### Dependency freshness (${report.generatedAt})\n`);
for (const level of ['major', 'minor', 'patch']) {
  const items = bySeverity[level];
  lines.push(`#### ${level} (${items.length})\n`);
  if (!items.length) {
    lines.push('_none_\n');
    continue;
  }
  lines.push('| Workspace package | Dependency | Current | Latest |');
  lines.push('| --- | --- | --- | --- |');
  for (const it of items) lines.push(`| \`${it.package}\` | \`${it.name}\` | ${it.current} | ${it.latest} |`);
  lines.push('');
}
if (bySeverity.major.length) {
  lines.push('> Major updates are **not** applied automatically. Review the changelogs above, then run');
  lines.push('> `pnpm hypdriv deps --update major --only <name>` for each one you accept.');
}
const md = lines.join('\n');
console.log(md);
writeFileSync('deps-report.md', md);
