import { describe, expect, it } from 'vitest';
import {
  addToConfigArray,
  configObjectStart,
  ensureImportLine,
  ensureNamedImports,
  importsName,
  wrapPropertyValue,
} from './config-edit';

const MODULE = '@hypdriv/vite';

describe('importsName', () => {
  it('counts only value imports of the name from that module', () => {
    expect(importsName(`import { a, b } from '${MODULE}';`, MODULE, 'b')).toBe(true);
    expect(importsName(`import { a } from '${MODULE}';`, MODULE, 'b')).toBe(false);
    expect(importsName(`import { a } from 'other';`, MODULE, 'a')).toBe(false);
    expect(importsName(`import type { a } from '${MODULE}';`, MODULE, 'a')).toBe(false);
    expect(importsName(`import { type a, b } from '${MODULE}';`, MODULE, 'a')).toBe(false);
    // An alias binds another local name: the code does not call `a`.
    expect(importsName(`import { a as b } from '${MODULE}';`, MODULE, 'a')).toBe(false);
    expect(importsName(`// import { a } from '${MODULE}';\n`, MODULE, 'a')).toBe(false);
  });
});

describe('ensureNamedImports', () => {
  it('leaves a source that imports every name alone', () => {
    const source = `import { a, b } from '${MODULE}';\n`;
    expect(ensureNamedImports(source, MODULE, ['b', 'a'])).toBe(source);
  });

  it('adds the missing names to the existing import', () => {
    expect(ensureNamedImports(`import { a } from '${MODULE}';\nx();\n`, MODULE, ['a', 'b', 'c'])).toBe(
      `import { a, b, c } from '${MODULE}';\nx();\n`,
    );
    expect(ensureNamedImports(`import d, { a } from '${MODULE}';\n`, MODULE, ['b'])).toBe(
      `import d, { a, b } from '${MODULE}';\n`,
    );
    expect(ensureNamedImports(`import { a, } from '${MODULE}';\n`, MODULE, ['b'])).toBe(
      `import { a, b, } from '${MODULE}';\n`,
    );
    expect(ensureNamedImports(`import {\n  a,\n} from '${MODULE}';\n`, MODULE, ['b'])).toBe(
      `import {\n  a,\n  b,\n} from '${MODULE}';\n`,
    );
  });

  it('writes a line of its own when no value import with braces exists', () => {
    const typed = ensureNamedImports(`import type { T } from '${MODULE}';\n`, MODULE, ['a']);
    expect(typed).toContain(`import { a } from '${MODULE}';`);
    expect(typed).toContain(`import type { T } from '${MODULE}';`);
    expect(ensureNamedImports(`import * as ns from '${MODULE}';\n`, MODULE, ['a'])).toContain(
      `import { a } from '${MODULE}';`,
    );
    expect(ensureNamedImports('export default {};\n', MODULE, ['a', 'b'])).toBe(
      `import { a, b } from '${MODULE}';\nexport default {};\n`,
    );
  });
});

describe('ensureImportLine', () => {
  it('imports the names of a named import line one by one', () => {
    expect(
      ensureImportLine(
        `import { other } from '${MODULE}';\n`,
        `import { hypdriv } from '${MODULE}';`,
        MODULE,
      ),
    ).toBe(`import { other, hypdriv } from '${MODULE}';\n`);
  });

  it('keeps the module-level check for any other form of import line', () => {
    const line = `import tsconfigPaths from 'vite-tsconfig-paths';`;
    expect(ensureImportLine('export default {};\n', line, 'vite-tsconfig-paths')).toContain(line);
    const present = `import tsconfigPaths from 'vite-tsconfig-paths';\n`;
    expect(ensureImportLine(present, line, 'vite-tsconfig-paths')).toBe(present);
  });
});

describe('config edits import what they use', () => {
  it('addToConfigArray adds the plugin import even when the module is already imported for something else', () => {
    const source = `import { other } from '${MODULE}';\n\nexport default { plugins: [other()] };\n`;
    const r = addToConfigArray(source, {
      property: 'plugins',
      element: 'hypdriv()',
      importLine: `import { hypdriv } from '${MODULE}';`,
      importFrom: MODULE,
    });
    expect(r.changed).toBe(true);
    expect(r.content).toContain(`import { other, hypdriv } from '${MODULE}';`);
    expect(r.content).toContain('plugins: [hypdriv(), other()]');
  });

  it('wrapPropertyValue does the same for the wrapper it introduces', () => {
    const source = `import { keep } from 'adapter-wrap';\nexport default { kit: { adapter: adapter() } };\n`;
    const r = wrapPropertyValue(source, {
      property: 'adapter',
      wrapper: 'hypdriv',
      importLine: `import { hypdriv } from 'adapter-wrap';`,
      importFrom: 'adapter-wrap',
    });
    expect(r.content).toContain("import { keep, hypdriv } from 'adapter-wrap';");
    expect(r.content).toContain('adapter: hypdriv(adapter())');
  });
});

describe("addToConfigArray finds the config object's own property", () => {
  const add = (source: string, extra: Record<string, unknown> = {}) =>
    addToConfigArray(source, {
      property: 'plugins',
      element: 'hypdriv()',
      importLine: `import { hypdriv } from '${MODULE}';`,
      importFrom: MODULE,
      ...extra,
    });

  it("does not take a nested plugins array (css.postcss.plugins) for the config's", () => {
    const source = `export default defineConfig({\n  css: { postcss: { plugins: [autoprefixer()] } },\n  plugins: [react()],\n});\n`;
    const r = add(source);
    expect(r.content).toContain('css: { postcss: { plugins: [autoprefixer()] } }');
    expect(r.content).toContain('plugins: [hypdriv(), react()]');
  });

  it('creates the property when only a nested one exists', () => {
    const source = `export default defineConfig({\n  css: { postcss: { plugins: [autoprefixer()] } },\n});\n`;
    const r = add(source);
    expect(r.content).toContain('css: { postcss: { plugins: [autoprefixer()] } }');
    expect(r.content).toMatch(/\n {2}plugins: \[hypdriv\(\)\],/);
    expect(r.content.match(/plugins:/g)).toHaveLength(2);
  });

  it('does not take the key of a nested object or a string for the property', () => {
    const source = `export default defineConfig({\n  define: { 'plugins': 'x' },\n  build: { rollupOptions: { plugins: [] } },\n  plugins: [],\n});\n`;
    const r = add(source);
    expect(r.content).toContain('build: { rollupOptions: { plugins: [] } }');
    expect(r.content).toContain('plugins: [hypdriv()]');
  });

  it('keeps a property whose value is not an array literal and spreads it', () => {
    const shorthand = add(`const plugins = [react()];\nexport default defineConfig({ plugins });\n`);
    expect(shorthand.content).toContain('defineConfig({ plugins: [hypdriv(), ...plugins] })');
    const call = add(`export default defineConfig({ plugins: makePlugins(), base: '/' });\n`);
    expect(call.content).toContain("plugins: [hypdriv(), ...makePlugins()], base: '/'");
    const last = add(`export default defineConfig({ plugins: makePlugins() });\n`, { position: 'last' });
    expect(last.content).toContain('plugins: [...makePlugins(), hypdriv()]');
    // Nothing is registered twice, and no second `plugins` key is created.
    const again = add(call.content);
    expect(again.changed).toBe(false);
    expect(add(call.content).content.match(/plugins:/g)).toHaveLength(1);
  });

  it('skips spreads and methods while looking for the property', () => {
    const source = `export default defineConfig({\n  ...base,\n  resolve() { return { plugins: [] }; },\n  plugins: [react()],\n});\n`;
    expect(add(source).content).toContain('plugins: [hypdriv(), react()]');
  });

  it('reaches into a nested object on request', () => {
    const source = `export default defineConfig({\n  vite: { plugins: [tailwind()] },\n  plugins: [top()],\n});\n`;
    const r = add(source, { within: 'vite', position: 'first' });
    expect(r.content).toContain('vite: { plugins: [hypdriv(), tailwind()] }');
    expect(r.content).toContain('plugins: [top()]');
    expect(add(`export default defineConfig({});\n`, { within: 'vite' })).toMatchObject({
      changed: false,
      reason: 'no vite object',
    });
  });
});

describe('configObjectStart for function configs', () => {
  it('picks the final return of the function body, not an early exit', () => {
    const source = `export default defineConfig(({ mode }) => {\n  if (mode === 'test') return { test: true };\n  const base = { a: 1 };\n  return { plugins: [react()] };\n});\n`;
    const start = configObjectStart(source);
    expect(source.slice(start, start + 22)).toBe('{ plugins: [react()] }');
  });

  it('ignores returns inside nested blocks and functions', () => {
    const source = `export default defineConfig(() => {\n  const f = () => { return { nested: true }; };\n  return { plugins: [] };\n});\n`;
    const start = configObjectStart(source);
    expect(source.slice(start, start + 15)).toBe('{ plugins: [] }');
  });
});
