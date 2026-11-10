import { describe, expect, it } from 'vitest';
import { honoRegistration, maskSource } from './hono';

describe('honoRegistration', () => {
  it('accepts the middleware first', () => {
    const src = "const app = new Hono();\nuseHypDriv(app, { config });\napp.get('/', (c) => c.text('x'));\n";
    expect(honoRegistration(src)).toEqual({ wrapped: false, routesBefore: null });
    expect(honoRegistration("app.use(hypdriv({ config }));\napp.get('/', h);")).toEqual({
      wrapped: false,
      routesBefore: null,
    });
    expect(honoRegistration("app.use('*', hypdriv({ config }));\napp.post('/', h);")).toEqual({
      wrapped: false,
      routesBefore: null,
    });
  });

  it('names the first route registered before it', () => {
    const src = "const app = new Hono();\napp.get('/health', h);\nuseHypDriv(app, { config });\n";
    expect(honoRegistration(src)).toEqual({ wrapped: false, routesBefore: '.get()' });
  });

  it('treats wrapHono as order independent and unrelated code as unregistered', () => {
    expect(honoRegistration("app.get('/', h);\nexport default wrapHono(app, { config });")).toEqual({
      wrapped: true,
      routesBefore: null,
    });
    expect(honoRegistration("app.get('/', h);")).toBeNull();
  });

  it('ignores calls that merely look like routes', () => {
    const src = [
      'const app = new Hono();',
      'const [a, b] = await Promise.all([load(), load()]);',
      "const user = c.get('user');",
      'useHypDriv(app, { config });',
      "app.get('/', h);",
    ].join('\n');
    expect(honoRegistration(src)).toEqual({ wrapped: false, routesBefore: null });
  });

  it('only counts routes of the app the middleware is registered on', () => {
    const sub =
      "const api = new Hono();\napi.get('/x', h);\nconst app = new Hono();\nuseHypDriv(app, { config });";
    expect(honoRegistration(sub)).toEqual({ wrapped: false, routesBefore: null });
    const chained = "const app = new Hono().get('/health', h);\nuseHypDriv(app, { config });";
    expect(honoRegistration(chained)).toEqual({ wrapped: false, routesBefore: '.get()' });
  });

  it('is not fooled by comments and strings', () => {
    const commented =
      "// export default wrapHono(app, { config });\n/* app.get('/old', h); */\nuseHypDriv(app, { config });\n";
    expect(honoRegistration(commented)).toEqual({ wrapped: false, routesBefore: null });
    expect(honoRegistration("const hint = 'use wrapHono(app) instead';\napp.get('/', h);")).toBeNull();
    expect(
      honoRegistration("app.use('*', hypdriv({ config }));\nconst url = 'https://x.dev/a'; app.get('/', h);"),
    ).toEqual({ wrapped: false, routesBefore: null });
  });

  it('does not guess when a literal is left open', () => {
    expect(maskSource("const a = 'open;\nuseHypDriv(app);")).toBeNull();
    expect(maskSource('/* never closed')).toBeNull();
    expect(honoRegistration("const a = 'open;\nuseHypDriv(app); app.get('/', h);")).toBeNull();
  });

  it('masks regular expression literals and tells them from divisions', () => {
    const source = `const esc = (v) => v.replace(/[&<>"']/g, (c) => \`&#\${c};\`);\nuseHypDriv(app, { config });`;
    const masked = maskSource(source);
    expect(masked).not.toBeNull();
    expect(masked?.length).toBe(source.length);
    expect(masked).toContain('/_______/g');
    expect(honoRegistration(`${source}\napp.get('/', h);`)).toEqual({ wrapped: false, routesBefore: null });
    // Divisions stay code: the quote after them still opens a string.
    expect(maskSource("const half = total / 2; const s = 'a/b';")).toBe(
      "const half = total / 2; const s = '___';",
    );
    expect(maskSource('return /x\\/y[/]/.test(s);')).toBe('return /_______/.test(s);');
    expect(maskSource('const r = /open')).toBeNull();
  });

  it('keeps indices when masking', () => {
    const source = `a('x\\'y'); // tail\n\`t\${1}\`;`;
    expect(maskSource(source)?.length).toBe(source.length);
  });
});
