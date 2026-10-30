import {
  cyrb53,
  type DurableObjectIdLike,
  type DurableObjectNamespaceLike,
  type DurableObjectStubLike,
} from '@hypdriv/core';

export interface FakeDurableObjectId extends DurableObjectIdLike {
  /** 64 hex characters, deterministic for `idFromName`. */
  toString(): string;
  name?: string;
  equals(other: DurableObjectIdLike): boolean;
}

/** What the factory returns: anything with `fetch`, plus optional RPC-style methods. */
export interface FakeDurableObjectInstance {
  fetch(request: Request): Promise<Response> | Response;
  [method: string]: unknown;
}

export interface FakeDurableObjectStub extends DurableObjectStubLike {
  readonly id: FakeDurableObjectId;
  readonly name: string | undefined;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface FakeDurableObjectNamespace extends DurableObjectNamespaceLike<FakeDurableObjectStub> {
  idFromName(name: string): FakeDurableObjectId;
  idFromString(id: string): FakeDurableObjectId;
  newUniqueId(): FakeDurableObjectId;
  get(id: DurableObjectIdLike): FakeDurableObjectStub;
  /** Instances created so far, keyed by id string (inspect state from tests). */
  instances(): Map<string, FakeDurableObjectInstance>;
  /** Every fetch that reached an instance. */
  readonly fetches: Array<{ id: string; name: string | undefined; request: Request }>;
  /** Drops instances and stubs; the next `get` creates fresh ones. */
  reset(): void;
}

const BASE_URL = 'https://fake-durable-object.hypdriv.local';

function makeId(hex: string, name?: string): FakeDurableObjectId {
  return {
    name,
    toString: () => hex,
    equals: (other) => other.toString() === hex,
  };
}

/** Deterministic 64-hex id for a name (four cyrb53 lanes). */
export function fakeIdFromName(name: string): string {
  return [0, 1, 2, 3].map((seed) => cyrb53(name, seed).toString(16).padStart(16, '0')).join('');
}

/**
 * A `DurableObjectNamespace` whose objects are created by `factory(id)` on first `get` and memoised per
 * id, so state persists across `get()` calls like a real namespace. Stubs forward `fetch` to the
 * instance (relative URLs are resolved against a synthetic origin) and expose instance methods for
 * RPC-style calls (`stub.increment()`), always as promises.
 */
export function createFakeDurableObjectNamespace(
  factory: (id: FakeDurableObjectId) => FakeDurableObjectInstance,
): FakeDurableObjectNamespace {
  let instances = new Map<string, FakeDurableObjectInstance>();
  let stubs = new Map<string, FakeDurableObjectStub>();
  const fetches: FakeDurableObjectNamespace['fetches'] = [];

  const instanceFor = (id: FakeDurableObjectId): FakeDurableObjectInstance => {
    const key = id.toString();
    let instance = instances.get(key);
    if (!instance) {
      instance = factory(id);
      instances.set(key, instance);
    }
    return instance;
  };

  const makeStub = (id: FakeDurableObjectId): FakeDurableObjectStub => {
    const base = {
      id,
      name: id.name,
      async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        let request: Request;
        if (input instanceof Request) request = init ? new Request(input, init) : input;
        else {
          const raw = input instanceof URL ? input.href : String(input);
          const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : new URL(raw, BASE_URL).href;
          request = new Request(url, init);
        }
        fetches.push({ id: id.toString(), name: id.name, request });
        return instanceFor(id).fetch(request);
      },
    };
    return new Proxy(base as FakeDurableObjectStub, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return undefined;
        const instance = instanceFor(id);
        const value = instance[prop];
        if (typeof value === 'function')
          return (...args: unknown[]) =>
            Promise.resolve((value as (...a: unknown[]) => unknown).apply(instance, args));
        return value;
      },
    });
  };

  return {
    fetches,
    idFromName: (name) => makeId(fakeIdFromName(name), name),
    idFromString(id) {
      if (!/^[0-9a-f]{64}$/i.test(id)) throw new TypeError(`Invalid Durable Object ID: ${id}`);
      return makeId(id.toLowerCase());
    },
    newUniqueId() {
      const bytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(bytes);
      return makeId(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''));
    },
    get(id) {
      const key = id.toString();
      let stub = stubs.get(key);
      if (!stub) {
        const fullId = (id as FakeDurableObjectId).equals
          ? (id as FakeDurableObjectId)
          : makeId(key, id.name);
        stub = makeStub(fullId);
        stubs.set(key, stub);
      }
      return stub;
    },
    instances: () => instances,
    reset() {
      instances = new Map();
      stubs = new Map();
      fetches.length = 0;
    },
  };
}
