import type { HypManifest } from '@hypdriv/core';
import { formatBytes, frameworkLabel } from '@hypdriv/core';

/** Human-readable build report written next to the manifest (`.hypdriv/report.md`). */
export function renderReport(manifest: HypManifest): string {
  const lines: string[] = [];
  lines.push('# Hypdriv build report');
  lines.push('');
  lines.push(
    `- Build: \`${manifest.buildId}\` · ${frameworkLabel(manifest)} · Hypdriv ${manifest.hypdrivVersion} · ${manifest.generatedAt}`,
  );
  lines.push(
    `- Cache Components: ${manifest.cacheComponents ? 'on' : 'off'} · basePath: \`${manifest.basePath || '/'}\` · trailingSlash: ${manifest.trailingSlash}`,
  );
  lines.push(`- Routes: ${manifest.routes.length} · static files: ${manifest.staticFiles.count}`);
  lines.push('');
  lines.push('## Routes');
  lines.push('');
  lines.push('| Route | Kind | Class | Cache policy | CSP | JS (gzip) | CSS (gzip) | Hints |');
  lines.push('| --- | --- | --- | --- | --- | ---: | ---: | ---: |');
  for (const r of manifest.routes) {
    if (r.kind === 'static-file') continue;
    const w = manifest.weights.client[r.id];
    const cspMode =
      r.classification === 'static' && manifest.csp[r.id]
        ? 'hash'
        : r.classification === 'route'
          ? '—'
          : 'nonce';
    lines.push(
      `| \`${r.pathname}\` | ${r.kind} | ${r.classification}${r.prerender?.revalidate ? ` (${r.prerender.revalidate}s)` : ''} | ${r.cachePolicyId ?? '—'} | ${cspMode} | ${w ? formatBytes(w.js) : '—'} | ${w ? formatBytes(w.css) : '—'} | ${manifest.earlyHints[r.id]?.length ?? 0} |`,
    );
  }
  const assets = manifest.routes.filter((r) => r.kind === 'static-file');
  if (assets.length) {
    lines.push('');
    lines.push(`Public assets routed: ${assets.map((a) => `\`${a.pathname}\``).join(', ')}`);
  }
  if (manifest.budgets?.length) {
    lines.push('');
    lines.push('## Budgets');
    lines.push('');
    for (const b of manifest.budgets) {
      const fmt = b.metric === 'startupMs' ? (n: number) => `${n} ms` : formatBytes;
      lines.push(
        `- ${b.status === 'ok' ? '✅' : b.status === 'warn' ? '⚠️' : '❌'} ${b.id}${b.target ? ` (${b.target})` : ''}: ${fmt(b.actual)} / ${fmt(b.limit)}`,
      );
    }
  }
  if (manifest.purser) {
    lines.push('');
    lines.push('## Purser CSS');
    lines.push('');
    lines.push(
      `- Stylesheet: \`${manifest.purser.stylesheet}\`${manifest.purser.asset ? ` → \`${manifest.purser.asset}\`` : ''} (${manifest.purser.atoms} atoms, hash ${manifest.purser.stylesheetHash})`,
    );
    const missing = Object.entries(manifest.purser.missingAtoms).filter(([, v]) => v.length);
    lines.push(
      `- Missing atoms: ${missing.length ? missing.map(([route, atoms]) => `${route}: ${atoms.join(' ')}`).join('; ') : 'none'}`,
    );
    lines.push(`- Unused atoms: ${manifest.purser.unusedAtoms.length}`);
  }
  if (manifest.warnings.length) {
    lines.push('');
    lines.push('## Warnings');
    lines.push('');
    for (const w of manifest.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  return lines.join('\n');
}
