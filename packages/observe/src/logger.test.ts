import { resolveConfig } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { createLogger, redact, redactHeaders } from './logger';

function capture() {
  const lines: Array<{ level: string; json: Record<string, unknown> }> = [];
  return {
    lines,
    sink: (line: string, level: string) => {
      lines.push({ level, json: JSON.parse(line) as Record<string, unknown> });
    },
  };
}

describe('createLogger', () => {
  it('emits JSON lines with bound fields and redacts configured keys plus secret-looking ones', () => {
    const { lines, sink } = capture();
    const config = resolveConfig({ observe: { logging: { redact: ['email', 'ssn'] } } }).observe.logging;
    const log = createLogger(config, { service: 'app' }, { sink, clock: () => 'T' });
    log.info('hello', {
      email: 'a@b.c',
      nested: { ssn: '1', token: 'x', ok: 'fine' },
      authorization: 'Bearer abc',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: 'info',
      json: {
        time: 'T',
        level: 'info',
        msg: 'hello',
        service: 'app',
        email: '[redacted]',
        nested: { ssn: '[redacted]', token: '[redacted]', ok: 'fine' },
        authorization: '[redacted]',
      },
    });
    const child = log.child({ requestId: 'r1' });
    child.warn('w', { Email: 'x' });
    expect(lines[1]!.json).toMatchObject({ requestId: 'r1', Email: '[redacted]', msg: 'w' });
  });

  it('respects the level and never samples warn/error', () => {
    const { lines, sink } = capture();
    const config = resolveConfig({ observe: { logging: { level: 'warn', sampleRate: 0 } } }).observe.logging;
    const log = createLogger(config, {}, { sink });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => l.level)).toEqual(['warn', 'error']);
    expect(log.level).toBe('warn');
  });

  it('samples debug/info deterministically per request id, randomly otherwise', () => {
    const { lines, sink } = capture();
    const config = resolveConfig({ observe: { logging: { level: 'debug', sampleRate: 0.5 } } }).observe
      .logging;
    let r = 0;
    const log = createLogger(config, {}, { sink, random: () => r });
    log.info('kept');
    r = 0.9;
    log.info('dropped');
    expect(lines.map((l) => l.json.msg)).toEqual(['kept']);

    const kept: string[] = [];
    const dropped: string[] = [];
    for (let i = 0; i < 200; i++) {
      const id = `req-${i}`;
      const before = lines.length;
      log.child({ requestId: id }).info('x');
      log.child({ requestId: id }).debug('y');
      const emitted = lines.length - before;
      expect([0, 2]).toContain(emitted); // all-or-nothing per request
      (emitted ? kept : dropped).push(id);
    }
    expect(kept.length).toBeGreaterThan(50);
    expect(dropped.length).toBeGreaterThan(50);
    // Deterministic: the same id decides the same way again.
    const sample = kept[0]!;
    const before = lines.length;
    log.child({ requestId: sample }).info('again');
    expect(lines.length).toBe(before + 1);
  });

  it('exposes redact helpers', () => {
    expect(redact({ password: 'x', a: 1 })).toEqual({ password: '[redacted]', a: 1 });
    expect(redact({ custom: 'x' }, ['custom'])).toEqual({ custom: '[redacted]' });
    const headers = new Headers({
      authorization: 'Bearer t',
      cookie: 'a=b',
      'content-type': 'text/html',
      'x-secret': 's',
    });
    expect(redactHeaders(headers, ['x-secret'])).toEqual({
      authorization: '[redacted]',
      cookie: '[redacted]',
      'content-type': 'text/html',
      'x-secret': '[redacted]',
    });
    expect(redactHeaders({ 'Set-Cookie': ['a=1', 'b=2'], Accept: 'x', skip: undefined })).toEqual({
      'set-cookie': '[redacted]',
      accept: 'x',
    });
  });
});
