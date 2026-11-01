type Listener = (...args: unknown[]) => void;

/**
 * The subset of Node's `EventEmitter` that HTTP response consumers use (`on`, `once`, `off`, `emit`,
 * `prependListener`…), without importing `node:events` so the runtime also bundles for workerd.
 */
export class MiniEmitter {
  #listeners = new Map<string | symbol, Listener[]>();

  on(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener);
  }

  prependListener(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.unshift(listener);
    this.#listeners.set(event, list);
    return this;
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapped: Listener & { listener?: Listener } = (...args: unknown[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    wrapped.listener = listener;
    return this.on(event, wrapped);
  }

  prependOnceListener(event: string | symbol, listener: Listener): this {
    const wrapped: Listener & { listener?: Listener } = (...args: unknown[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    wrapped.listener = listener;
    return this.prependListener(event, wrapped);
  }

  off(event: string | symbol, listener: Listener): this {
    const list = this.#listeners.get(event);
    if (!list) return this;
    const index = list.findIndex(
      (l) => l === listener || (l as Listener & { listener?: Listener }).listener === listener,
    );
    if (index >= 0) list.splice(index, 1);
    if (!list.length) this.#listeners.delete(event);
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    return this.off(event, listener);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#listeners.clear();
    else this.#listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const list = this.#listeners.get(event);
    if (!list?.length) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this.#listeners.get(event)?.length ?? 0;
  }

  listeners(event: string | symbol): Listener[] {
    return [...(this.#listeners.get(event) ?? [])];
  }

  setMaxListeners(): this {
    return this;
  }
}
