// Copies the example apps into ./templates for publication (run by `pnpm build`).
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncTemplates } from '../src/templates.ts';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = syncTemplates({ repoRoot: join(pkgDir, '..', '..'), outDir: join(pkgDir, 'templates') });
for (const [id, files] of Object.entries(result))
  console.log(`create-hypdriv: template ${id} (${files.length} files)`);
