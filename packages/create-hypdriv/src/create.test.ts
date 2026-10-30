import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { type CliIO, main } from './cli';
import {
  compatibilityDate,
  detectPackageManager,
  fillSecrets,
  isUsableDirectory,
  scaffold,
  toPackageName,
  validateName,
  workerName,
} from './scaffold';
import {
  excluded,
  NAME,
  parseCatalog,
  syncTemplates,
  TEMPLATE_SOURCES,
  templateFor,
  transformHypdrivConfig,
  transformPackageJson,
  transformReadme,
  transformTsconfig,
} from './templates';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
let templatesDir = '';

beforeAll(() => {
  templatesDir = join(mkdtempSync(join(tmpdir(), 'create-hypdriv-templates-')), 'templates');
  syncTemplates({ repoRoot, outDir: templatesDir });
});

describe('template sync', () => {
  it('produces one template per example without build output or secrets', () => {
    const manifest = JSON.parse(readFileSync(join(templatesDir, 'manifest.json'), 'utf8')) as {
      hypdriv: string;
      templates: Record<string, string[]>;
    };
    expect(Object.keys(manifest.templates).sort()).toEqual(Object.keys(TEMPLATE_SOURCES).sort());
    for (const files of Object.values(manifest.templates)) {
      expect(files).toContain('_gitignore');
      expect(files).toContain('package.json');
      expect(files).toContain('README.md');
      expect(
        files.some((f) => /^(\.next|\.open-next|\.wrangler|\.hypdriv|\.vercel|node_modules)\//.test(f)),
      ).toBe(false);
      expect(files).not.toContain('.dev.vars');
      expect(files).not.toContain('.env.local');
      expect(files).not.toContain('app/purser.css');
      expect(files).not.toContain('next-env.d.ts');
    }
    expect(manifest.templates.cloudflare).toContain('wrangler.jsonc');
    expect(manifest.templates.cloudflare).toContain('hypdriv.worker.ts');
    expect(manifest.templates.vercel).toContain('vercel.json');
    expect(manifest.templates.vercel).not.toContain('wrangler.jsonc');
    expect(manifest.templates['vercel-purser']).toContain('lib/tokens.ts');
    for (const files of Object.values(manifest.templates))
      expect(files.filter((f) => /\.local\.|^\.dev\.vars\./.test(f) && f !== '.dev.vars.example')).toEqual(
        [],
      );
  });

  it('never copies account-specific configurations or local env files', () => {
    for (const file of [
      'wrangler.avonao-hypdriv-dev.local.jsonc',
      'wrangler.prod.local.json',
      'wrangler.staging.local.toml',
      '.env.local',
      '.env.production.local',
      '.dev.vars',
      '.dev.vars.production',
      '.hypdriv/manifest.json',
    ])
      expect(excluded(file)).toBe(true);
    for (const file of ['wrangler.jsonc', '.dev.vars.example', '.env.example', 'app/page.tsx'])
      expect(excluded(file)).toBe(false);
  });

  it('pins catalog and workspace versions and drops the source condition', () => {
    for (const id of Object.keys(TEMPLATE_SOURCES)) {
      const pkg = readFileSync(join(templatesDir, id, 'package.json'), 'utf8');
      expect(pkg).not.toMatch(/"(catalog|workspace):/);
      expect(JSON.parse(pkg).name).toBe(NAME);
      expect(readFileSync(join(templatesDir, id, 'tsconfig.json'), 'utf8')).not.toContain('customConditions');
    }
  });

  it('parses the pnpm catalog and transforms files', () => {
    expect(
      parseCatalog(
        'packages:\n  - a\ncatalog:\n  next: ^16.4.3\n  "@types/node": ^26.6.6 # pinned\nother:\n  x: 1\n',
      ),
    ).toEqual({
      next: '^16.4.3',
      '@types/node': '^26.6.6',
    });
    const pkg = JSON.parse(
      transformPackageJson(
        JSON.stringify({
          name: 'x',
          dependencies: { next: 'catalog:', hypdriv: 'workspace:*', zod: '^4.0.0' },
        }),
        { catalog: { next: '^16.4.3' }, workspace: { hypdriv: '0.3.1' } },
      ),
    );
    expect(pkg).toMatchObject({
      name: NAME,
      private: true,
      dependencies: { next: '^16.4.3', hypdriv: '^0.3.1', zod: '^4.0.0' },
    });
    expect(() =>
      transformPackageJson(JSON.stringify({ dependencies: { a: 'catalog:' } }), {
        catalog: {},
        workspace: {},
      }),
    ).toThrow(/catalog/);
    expect(
      transformTsconfig('{"compilerOptions":{"strict":true,"customConditions":["source"]}}'),
    ).not.toContain('customConditions');
    expect(transformHypdrivConfig("  site: { name: 'shop', origin: 'https://shop.dev' },")).toContain(
      "site: { name: 'shop' /* , origin:",
    );
    expect(transformReadme('# Example\n\nBody\n', 'vercel')).toMatch(
      new RegExp(`^# ${NAME}\\n\\nScaffolded with .*\`vercel\` template\\.\\n\\nBody`),
    );
  });
});

describe('helpers', () => {
  it('validates and derives package names', () => {
    expect(validateName('my-app')).toBeNull();
    expect(validateName('@acme/shop')).toBeNull();
    expect(validateName('My-App')).toMatch(/lowercase/);
    expect(validateName('.hidden')).toMatch(/cannot start/);
    expect(validateName('a b')).toMatch(/may only contain/);
    expect(toPackageName('/tmp/My Shop!')).toBe('my-shop');
    expect(toPackageName('/tmp/___')).toBe('hypdriv-app');
    expect(workerName('@acme/shop.web')).toBe('shop-web');
    expect(workerName('x'.repeat(80))).toHaveLength(63);
  });

  it('detects the package manager and a compatibility date', () => {
    expect(detectPackageManager('pnpm/10.18.0 npm/? node/v22.23.4 linux x64')).toBe('pnpm');
    expect(detectPackageManager('yarn/4.9.1 npm/? node/v22')).toBe('yarn');
    expect(detectPackageManager('bun/1.3.0')).toBe('bun');
    expect(detectPackageManager(undefined)).toBe('npm');
    expect(compatibilityDate(new Date('2026-10-30T12:00:00Z'))).toBe('2026-10-01');
  });

  it('fills secrets without touching other values', () => {
    let n = 0;
    const out = fillSecrets(
      'NEXTJS_ENV=development\nHYPDRIV_SESSION_SECRET=change-me-please\nCRON_SECRET=\nKV_REST_API_TOKEN=\n# HYPDRIV_X_SECRET=\n',
      () => `s${++n}`,
    );
    expect(out).toBe(
      'NEXTJS_ENV=development\nHYPDRIV_SESSION_SECRET=s1\nCRON_SECRET=s2\nKV_REST_API_TOKEN=\n# HYPDRIV_X_SECRET=\n',
    );
  });

  it('accepts only empty target directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'create-hypdriv-target-'));
    expect(isUsableDirectory(join(dir, 'missing'))).toBe(true);
    mkdirSync(join(dir, '.git'));
    expect(isUsableDirectory(dir)).toBe(true);
    writeFileSync(join(dir, 'index.ts'), '');
    expect(isUsableDirectory(dir)).toBe(false);
  });
});

describe('scaffold', () => {
  const now = new Date('2026-10-30T12:00:00Z');
  const secret = () => 'generated-secret-value';

  it.each([
    ['cloudflare', false],
    ['cloudflare', true],
    ['vercel', false],
    ['vercel', true],
  ] as const)('creates a %s app (purser: %s)', (platform, purser) => {
    const cwd = mkdtempSync(join(tmpdir(), 'create-hypdriv-app-'));
    const result = scaffold({
      directory: 'shop',
      cwd,
      platform,
      purser,
      packageManager: 'pnpm',
      templatesDir,
      now,
      secret,
    });
    expect(result.template).toBe(templateFor(platform, purser));
    expect(result.name).toBe('shop');
    const read = (f: string) => readFileSync(join(result.root, f), 'utf8');
    expect(existsSync(join(result.root, '.gitignore'))).toBe(true);
    expect(existsSync(join(result.root, '_gitignore'))).toBe(false);
    for (const f of result.files)
      if (/\.(ts|tsx|json|jsonc|md)$/.test(f)) expect(read(f)).not.toContain('__HYPDRIV_APP_NAME');
    expect(JSON.parse(read('package.json')).name).toBe('shop');
    expect(read('hypdriv.config.ts')).toContain("site: { name: 'shop'");
    expect(read('README.md')).toMatch(/^# shop\n/);
    expect(read('pnpm-workspace.yaml')).toContain('allowBuilds:');
    if (platform === 'cloudflare') {
      const wrangler = read('wrangler.jsonc');
      expect(wrangler).toContain('"name": "shop"');
      expect(wrangler).toContain('"compatibility_date": "2026-10-01"');
      expect(wrangler).toContain('"bucket_name": "shop-opennext-cache"');
      expect(read('.dev.vars')).toContain('HYPDRIV_SESSION_SECRET=generated-secret-value');
      expect(result.secretsFile).toBe('.dev.vars');
    } else {
      expect(read('vercel.json')).toContain('"iad1"');
      expect(read('.env.local')).toContain('HYPDRIV_INTERNAL_SECRET=generated-secret-value');
      expect(result.secretsFile).toBe('.env.local');
    }
    if (purser) expect(existsSync(join(result.root, 'lib/tokens.ts'))).toBe(true);
  });

  it('uses Workers-safe names in wrangler.jsonc for scoped packages', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'create-hypdriv-scoped-'));
    const result = scaffold({
      directory: 'web',
      name: '@acme/web',
      cwd,
      platform: 'cloudflare',
      purser: false,
      packageManager: 'npm',
      templatesDir,
      now,
      secret,
    });
    const wrangler = readFileSync(join(result.root, 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toContain('"name": "web"');
    expect(wrangler).toContain('"service": "web"');
    expect(wrangler).toContain('"dataset": "web"');
    expect(JSON.parse(readFileSync(join(result.root, 'package.json'), 'utf8')).name).toBe('@acme/web');
    expect(existsSync(join(result.root, 'pnpm-workspace.yaml'))).toBe(false);
  });

  it('refuses non-empty directories and invalid names', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'create-hypdriv-refuse-'));
    mkdirSync(join(cwd, 'taken'));
    writeFileSync(join(cwd, 'taken', 'page.tsx'), '');
    const base = {
      cwd,
      platform: 'vercel' as const,
      purser: false,
      packageManager: 'npm' as const,
      templatesDir,
    };
    expect(() => scaffold({ ...base, directory: 'taken' })).toThrow(/not empty/);
    expect(() => scaffold({ ...base, directory: 'ok', name: 'Bad Name' })).toThrow(/lowercase/);
  });
});

describe('cli', () => {
  function io(argv: string[], extra: Partial<CliIO> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];
    const cwd = mkdtempSync(join(tmpdir(), 'create-hypdriv-cli-'));
    const value: CliIO = {
      argv,
      env: { npm_config_user_agent: 'pnpm/10.18.0 npm/? node/v22.23.4' },
      cwd,
      stdout: { write: (t) => void out.push(t) },
      stderr: { write: (t) => void err.push(t) },
      interactive: false,
      run: (command, args) => {
        commands.push({ command, args });
        return 0;
      },
      templatesDir,
      ...extra,
    };
    return { value, out, err, commands, cwd };
  }

  it('scaffolds non-interactively, installs and commits', async () => {
    const t = io(['shop', '--platform', 'vercel', '--json']);
    expect(await main(t.value)).toBe(0);
    const result = JSON.parse(t.out.join('')) as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      name: 'shop',
      template: 'vercel',
      packageManager: 'pnpm',
      installed: true,
      git: 'committed',
    });
    expect(t.commands.map((c) => `${c.command} ${c.args.join(' ')}`)).toEqual([
      'pnpm install',
      'git init -q',
      'git add -A',
      'git commit -q -m Initial commit from create-hypdriv',
    ]);
    expect(result.next).toContain('pnpm dev');
  });

  it('honours --no-install, --no-git, --pm and --purser', async () => {
    const t = io(['site', '--purser', '--pm', 'npm', '--no-install', '--no-git']);
    expect(await main(t.value)).toBe(0);
    expect(t.commands).toEqual([]);
    const text = t.out.join('');
    expect(text).toContain('Created site (cloudflare-purser)');
    expect(text).toContain('npm install');
    expect(text).toContain('npm run preview');
  });

  it('asks on a TTY when options are missing', async () => {
    const answers = ['my-app', 'v', 'y'];
    const t = io([], { interactive: true, ask: async () => answers.shift() ?? '' });
    expect(await main({ ...t.value, run: () => 0 })).toBe(0);
    expect(t.out.join('')).toContain('Created my-app (vercel-purser)');
  });

  it('rejects bad options and existing directories', async () => {
    expect(await main(io(['x', '--platform', 'aws']).value)).toBe(2);
    expect(await main(io(['x', '--pm', 'deno']).value)).toBe(2);
    expect(await main(io(['x', '--unknown']).value)).toBe(2);
    expect(await main(io(['x', '--name', 'Bad']).value)).toBe(2);
    const t = io(['taken']);
    mkdirSync(join(t.cwd, 'taken'));
    writeFileSync(join(t.cwd, 'taken', 'file.txt'), 'x');
    expect(await main(t.value)).toBe(1);
    const help = io(['--help']);
    expect(await main(help.value)).toBe(0);
    expect(help.out.join('')).toContain('--platform <cloudflare|vercel>');
  });

  it('reports a failed install without failing the scaffold', async () => {
    const t = io(['shop', '--no-git'], { run: () => 1 });
    expect(await main(t.value)).toBe(0);
    expect(t.err.join('')).toContain('install failed');
  });
});
