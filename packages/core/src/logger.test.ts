import { describe, expect, it } from 'vitest';
import { createConsoleLogger, redactFields } from './logger';

// assembled at run time so the fixture never appears as a literal in the source
const STRIPE_LIKE = ['sk', 'live', '51HxAbCdEfGhIjKlMnOpQrStUvWxYz0123456789'].join('_');

describe('redactFields', () => {
  it('redacts secret-looking keys and opaque credential values', () => {
    const out = redactFields({
      password: 'hunter2',
      apiKey: 'abc',
      nested: { authorization: 'Bearer x', note: STRIPE_LIKE },
      list: ['plain', 'ghp_0123456789abcdefghijABCDEFGHIJ0123456789'],
    });
    expect(out.password).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).authorization).toBe('[redacted]');
    expect((out.nested as Record<string, unknown>).note).toBe('[redacted]');
    expect(out.list).toEqual(['plain', '[redacted]']);
  });

  it('keeps correlation identifiers intact', () => {
    const requestId = '0192f3a4-5b6c-7d8e-9f01-23456789abcd';
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const out = redactFields({
      requestId,
      traceId,
      spanId: '00f067aa0ba902b7',
      buildId: 'b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
    });
    expect(out).toEqual({
      requestId,
      traceId,
      spanId: '00f067aa0ba902b7',
      buildId: 'b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7',
    });
  });

  it('honours extra redact keys and extra allowed id keys', () => {
    const value = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
    expect(redactFields({ orderRef: value }, [], ['orderRef'])).toEqual({ orderRef: value });
    expect(redactFields({ orderRef: value })).toEqual({ orderRef: '[redacted]' });
    expect(redactFields({ email: 'a@b.c' }, ['email'])).toEqual({ email: '[redacted]' });
  });

  it('still redacts secret keys even when the key is in the allow list', () => {
    expect(redactFields({ sessionToken: 'x' }, [], ['sessionToken'])).toEqual({ sessionToken: '[redacted]' });
  });
});

describe('createConsoleLogger', () => {
  it('writes JSON lines with redacted fields and keeps request ids', () => {
    const lines: string[] = [];
    const log = createConsoleLogger({ clock: () => 'T', sink: (line) => lines.push(line) });
    log.child({ requestId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd' }).info('hello', { token: 'secret' });
    expect(JSON.parse(lines[0]!)).toEqual({
      time: 'T',
      level: 'info',
      msg: 'hello',
      requestId: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
      token: '[redacted]',
    });
  });

  it('respects the level threshold', () => {
    const lines: string[] = [];
    const log = createConsoleLogger({ level: 'warn', sink: (line) => lines.push(line) });
    log.info('skip');
    log.warn('keep');
    expect(lines).toHaveLength(1);
  });
});
