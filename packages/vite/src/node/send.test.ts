import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { sendWebResponse } from './index';

/** A response that records what is written, like the middleware layers (`compression`) that wrap `writeHead`. */
function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & {
    calls: unknown[][];
    written: string;
    ended: boolean;
    writeHead(...args: unknown[]): unknown;
    write(chunk: Uint8Array): boolean;
    end(): void;
  };
  res.calls = [];
  res.written = '';
  res.ended = false;
  res.writeHead = (...args) => {
    res.calls.push(args);
    return res;
  };
  res.write = (chunk) => {
    res.written += new TextDecoder().decode(chunk);
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

describe('sendWebResponse', () => {
  it('passes the headers as the second argument when the response has no status text', async () => {
    const res = fakeResponse();
    await sendWebResponse(
      res as unknown as ServerResponse,
      new Response('hello', { status: 200, headers: { 'x-a': '1', 'content-type': 'text/plain' } }),
    );
    // `on-headers` treats an `undefined` second argument as the headers and drops the third.
    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]).toHaveLength(2);
    expect(res.calls[0]?.[0]).toBe(200);
    expect(res.calls[0]?.[1]).toMatchObject({ 'x-a': '1', 'content-type': 'text/plain' });
    expect(res.written).toBe('hello');
    expect(res.ended).toBe(true);
  });

  it('keeps the status text and the cookies when the response has them', async () => {
    const res = fakeResponse();
    const headers = new Headers();
    headers.append('set-cookie', 'a=1');
    headers.append('set-cookie', 'b=2');
    await sendWebResponse(
      res as unknown as ServerResponse,
      new Response('x', { status: 201, statusText: 'Created', headers }),
    );
    expect(res.calls[0]?.slice(0, 2)).toEqual([201, 'Created']);
    expect(((res.calls[0]?.[2] ?? {}) as Record<string, unknown>)['set-cookie']).toEqual(['a=1', 'b=2']);
  });

  it('ends without a body for HEAD and 204', async () => {
    const head = fakeResponse();
    await sendWebResponse(head as unknown as ServerResponse, new Response('body'), 'HEAD');
    expect(head.written).toBe('');
    expect(head.ended).toBe(true);
    const none = fakeResponse();
    await sendWebResponse(none as unknown as ServerResponse, new Response(null, { status: 204 }));
    expect(none.calls[0]?.[0]).toBe(204);
    expect(none.ended).toBe(true);
  });
});
