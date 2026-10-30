import type { StandardSchemaV1 as OfficialStandardSchema } from '@standard-schema/spec';
import { describe, expect, it, vi } from 'vitest';
import { fakeKv } from './__tests__/helpers';
import {
  ACTION_CONTEXT_GLOBAL,
  ActionError,
  createKvIdempotencyStore,
  createMemoryIdempotencyStore,
  formDataToObject,
  isNextNavigationError,
  safeAction,
} from './actions';
import { createRateLimiter } from './rate-limit/limiter';
import { createMemoryCounterStore } from './rate-limit/stores';
import type { StandardSchemaV1 } from './standard-schema';

/** A tiny Standard Schema implementation (what Zod/Valibot/ArkType produce). */
function schema<T>(
  check: (value: unknown) => { value: T } | { issues: Array<{ message: string; path?: PropertyKey[] }> },
): StandardSchemaV1<unknown, T> {
  return { '~standard': { version: 1, vendor: 'test', validate: (v) => check(v) } };
}
const createUser = schema<{ email: string; age: number }>((v) => {
  const issues: Array<{ message: string; path?: PropertyKey[] }> = [];
  const o = (v ?? {}) as Record<string, unknown>;
  if (typeof o.email !== 'string' || !o.email.includes('@'))
    issues.push({ message: 'Invalid email', path: ['email'] });
  const age = typeof o.age === 'string' ? Number(o.age) : o.age;
  if (typeof age !== 'number' || Number.isNaN(age) || age < 18)
    issues.push({ message: 'Must be 18+', path: ['age'] });
  if (o.forbidden) issues.push({ message: 'Nope' });
  return issues.length ? { issues } : { value: { email: o.email as string, age: age as number } };
});

describe('safeAction', () => {
  it('validates input and shapes field errors', async () => {
    const action = safeAction({ input: createUser, handler: async (input) => ({ id: 1, ...input }) });
    expect(await action({ email: 'a@b.co', age: 20 })).toEqual({
      ok: true,
      data: { id: 1, email: 'a@b.co', age: 20 },
    });
    const bad = await action({ email: 'nope', age: 3, forbidden: true });
    expect(bad).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'Invalid email',
        fieldErrors: { email: ['Invalid email'], age: ['Must be 18+'], _form: ['Nope'] },
      },
    });
  });

  it('accepts FormData directly and as (prevState, formData); strips Next internals', async () => {
    const action = safeAction({ input: createUser, handler: async (input) => input });
    const fd = new FormData();
    fd.set('email', 'x@y.z');
    fd.set('age', '30');
    fd.set('$ACTION_ID', 'internal');
    expect(await action(fd)).toEqual({ ok: true, data: { email: 'x@y.z', age: 30 } });
    expect(await action(null, fd)).toEqual({ ok: true, data: { email: 'x@y.z', age: 30 } });
    const multi = new FormData();
    multi.append('tag', 'a');
    multi.append('tag', 'b');
    expect(formDataToObject(multi)).toEqual({ tag: ['a', 'b'] });
  });

  it('auth, guards and error mapping never throw', async () => {
    const action = safeAction<{ email: string; age: number }, string, { id: string; role: string }>({
      input: createUser,
      auth: (ctx) =>
        ctx.headers?.get('authorization') === 'Bearer ok'
          ? { id: 'u1', role: ctx.headers.get('x-role') ?? 'user' }
          : null,
      guards: [(ctx) => ctx.auth.role === 'admin', () => undefined],
      handler: async (_input, ctx) => `hello ${ctx.auth.id}`,
    });
    const input = { email: 'a@b.co', age: 20 };
    expect((await action(input)).ok).toBe(false);
    expect(await action(input)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    const user = await action(input, { context: { headers: new Headers({ authorization: 'Bearer ok' }) } });
    expect(user).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    const admin = await action(input, {
      context: { headers: new Headers({ authorization: 'Bearer ok', 'x-role': 'admin' }) },
    });
    expect(admin).toEqual({ ok: true, data: 'hello u1' });

    const onError = vi.fn();
    const boom = safeAction({
      handler: async () => {
        throw new Error('db exploded');
      },
      onError,
    });
    const result = await boom({});
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
    expect(onError).toHaveBeenCalledOnce();

    const custom = safeAction({
      handler: async () => {
        throw new ActionError('CONFLICT', 'Already exists', { fieldErrors: { email: ['taken'] } });
      },
    });
    expect(await custom({})).toEqual({
      ok: false,
      error: { code: 'CONFLICT', message: 'Already exists', fieldErrors: { email: ['taken'] } },
    });
  });

  it('rate limits per key and reports retryAfter', async () => {
    const limiter = createRateLimiter({ store: createMemoryCounterStore() });
    const action = safeAction({
      name: 'ping',
      rateLimit: { key: (ctx) => ctx.ip ?? 'anon', limit: 2, window: '1m', algorithm: 'fixed-window' },
      limiter,
      handler: async () => 'pong',
    });
    const ctx = { context: { ip: '1.2.3.4' } };
    expect((await action({}, ctx)).ok).toBe(true);
    expect((await action({}, ctx)).ok).toBe(true);
    const limited = await action({}, ctx);
    expect(limited).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', retryAfter: expect.any(Number) },
    });
    expect((await action({}, { context: { ip: '5.6.7.8' } })).ok).toBe(true);
  });

  it('turnstile gate with a custom verifier', async () => {
    const verify = vi.fn(async (_secret: string, token: string) => ({
      success: token === 'ok',
      errorCodes: token === 'ok' ? [] : ['invalid-input-response'],
    }));
    const action = safeAction({
      input: createUser,
      turnstile: { secret: 's', verify },
      handler: async (input, ctx) => ({ input, turnstile: ctx.turnstile?.success }),
    });
    expect(await action({ email: 'a@b.co', age: 20 })).toMatchObject({
      ok: false,
      error: { code: 'CHALLENGE_FAILED', message: 'Missing challenge token' },
    });
    expect(await action({ email: 'a@b.co', age: 20, 'cf-turnstile-response': 'bad' })).toMatchObject({
      ok: false,
      error: { code: 'CHALLENGE_FAILED' },
    });
    const ok = await action({ email: 'a@b.co', age: 20, 'cf-turnstile-response': 'ok' });
    expect(ok).toEqual({ ok: true, data: { input: { email: 'a@b.co', age: 20 }, turnstile: true } });
    expect(await action({ email: 'a@b.co', age: 20 }, { turnstileToken: 'ok' })).toMatchObject({ ok: true });
  });

  it('idempotency replays the same result, rejects payload changes and concurrent duplicates', async () => {
    const store = createMemoryIdempotencyStore();
    let calls = 0;
    const action = safeAction({
      name: 'charge',
      input: schema<{ amount: number }>((v) => ({ value: v as { amount: number } })),
      idempotency: { store, ttlSeconds: 60 },
      handler: async (input) => ({ charged: input.amount, call: ++calls }),
    });
    const first = await action({ amount: 5 }, { idempotencyKey: 'k1' });
    const replay = await action({ amount: 5 }, { idempotencyKey: 'k1' });
    expect(first).toEqual({ ok: true, data: { charged: 5, call: 1 } });
    expect(replay).toEqual(first);
    expect(calls).toBe(1);
    expect(await action({ amount: 6 }, { idempotencyKey: 'k1' })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });
    expect(
      await action({ amount: 5 }, { context: { headers: new Headers({ 'idempotency-key': 'k2' }) } }),
    ).toEqual({ ok: true, data: { charged: 5, call: 2 } });

    await store.set('charge:k3', { status: 'pending', createdAt: Date.now() }, 60);
    expect(await action({ amount: 1 }, { idempotencyKey: 'k3' })).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    });

    // failures release the key so the client can retry
    const failing = safeAction({
      name: 'flaky',
      idempotency: { store },
      handler: async () => {
        if (calls++ < 3) throw new ActionError('INTERNAL');
        return 'ok';
      },
    });
    expect((await failing({}, { idempotencyKey: 'f' })).ok).toBe(false);
    expect(await failing({}, { idempotencyKey: 'f' })).toEqual({ ok: true, data: 'ok' });

    const kvStore = createKvIdempotencyStore(fakeKv());
    await kvStore.set('x', { status: 'done', result: { ok: true, data: 1 }, createdAt: 1 }, 10);
    expect(await kvStore.get('x')).toMatchObject({ status: 'done' });
    await kvStore.delete('x');
    expect(await kvStore.get('x')).toBeNull();
  });

  it('rethrows Next.js navigation errors and emits audit events', async () => {
    const audit = vi.fn();
    const redirectError = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307;',
    });
    const action = safeAction({
      name: 'nav',
      audit,
      handler: async () => {
        throw redirectError;
      },
    });
    await expect(action({})).rejects.toBe(redirectError);
    expect(isNextNavigationError(redirectError)).toBe(true);
    expect(isNextNavigationError({ digest: 'NEXT_NOT_FOUND' })).toBe(true);
    expect(isNextNavigationError({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBe(true);
    expect(isNextNavigationError(new Error('x'))).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'nav', ok: true, navigation: true }),
    );

    const ok = safeAction({ name: 'fine', audit, handler: async () => 1 });
    await ok({}, { context: { requestId: 'r1', ip: '9.9.9.9' } });
    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'fine', ok: true, requestId: 'r1', ip: '9.9.9.9', replayed: false }),
    );
  });

  it('reads the injectable context (global slot and getContext option)', async () => {
    const g = globalThis as Record<string, unknown>;
    g[ACTION_CONTEXT_GLOBAL] = () => ({ requestId: 'from-global', ip: '10.0.0.1' });
    try {
      const action = safeAction({ handler: async (_i, ctx) => `${ctx.requestId}/${ctx.ip}` });
      expect(await action({})).toEqual({ ok: true, data: 'from-global/10.0.0.1' });
      const custom = safeAction({
        getContext: () => ({ requestId: 'custom' }),
        handler: async (_i, ctx) => ctx.requestId,
      });
      expect(await custom({})).toEqual({ ok: true, data: 'custom' });
    } finally {
      delete g[ACTION_CONTEXT_GLOBAL];
    }
  });

  it('is compatible with the official Standard Schema type', () => {
    const official: OfficialStandardSchema<unknown, number> = {
      '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) },
    };
    const action = safeAction({ input: official, handler: async (n) => n + 1 });
    expect(action.actionName).toBe('action');
  });
});
