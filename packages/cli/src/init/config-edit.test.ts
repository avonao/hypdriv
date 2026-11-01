import { describe, expect, it } from 'vitest';
import {
  addToConfigArray,
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
    expect(ensureImportLine(`import { other } from '${MODULE}';\n`, `import { hypdriv } from '${MODULE}';`, MODULE)).toBe(
      `import { other, hypdriv } from '${MODULE}';\n`,
    );
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
