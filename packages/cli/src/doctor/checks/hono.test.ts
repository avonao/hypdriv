import { describe, expect, it } from 'vitest';
import { honoRegistration } from './hono';

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
});
