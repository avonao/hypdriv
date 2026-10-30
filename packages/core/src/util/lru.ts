/** Small LRU cache with optional per-entry TTL. Insertion order of `Map` provides recency. */
export class LRUCache<K, V> {
  private readonly map = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly defaultTtlMs: number = 0,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (capacity <= 0) throw new RangeError('LRU capacity must be positive');
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  peek(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K): boolean {
    return this.peek(key) !== undefined;
  }

  set(key: K, value: V, ttlMs: number = this.defaultTtlMs): this {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.capacity) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: ttlMs > 0 ? this.now() + ttlMs : 0 });
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  keys(): K[] {
    return [...this.map.keys()];
  }

  /** Removes expired entries. Returns the number removed. */
  prune(): number {
    const t = this.now();
    let removed = 0;
    for (const [k, e] of this.map) {
      if (e.expiresAt && e.expiresAt <= t) {
        this.map.delete(k);
        removed++;
      }
    }
    return removed;
  }
}
