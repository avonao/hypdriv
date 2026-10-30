/** Parses a duration (`30`, `'30s'`, `'5m'`, `'2h'`, `'1d'`, `'1w'`) into seconds. */
export function parseDuration(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid duration: ${value}`);
    return value;
  }
  const match =
    /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days|w|week|weeks)?\s*$/i.exec(value);
  if (!match) throw new RangeError(`Invalid duration: "${value}"`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const factor: Record<string, number> = {
    ms: 0.001,
    s: 1,
    sec: 1,
    secs: 1,
    m: 60,
    min: 60,
    mins: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
    w: 604800,
    week: 604800,
    weeks: 604800,
  };
  return amount * (factor[unit] ?? 1);
}

/** Parses a duration into milliseconds. */
export function parseDurationMs(value: number | string | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs;
  if (typeof value === 'number') return value * 1000;
  return Math.round(parseDuration(value, fallbackMs / 1000) * 1000);
}

/** Parses a size (`1024`, `'250kb'`, `'3mb'`, `'1gib'`) into bytes. */
export function parseSize(value: number | string | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid size: ${value}`);
    return Math.round(value);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?\s*$/i.exec(value);
  if (!match) throw new RangeError(`Invalid size: "${value}"`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const factor: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 * 1000,
    mib: 1024 * 1024,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  };
  return Math.round(amount * (factor[unit] ?? 1));
}

/** Formats bytes for humans (`12.3 kB`). */
export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes)) return String(bytes);
  const abs = Math.abs(bytes);
  if (abs < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (Math.abs(value) >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(digits)} ${units[i]}`;
}

/** Formats milliseconds for humans (`1.2 ms`, `3.4 s`). */
export function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Formats seconds as a compact duration (`90` → `1m30s`). */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const parts: string[] = [];
  const units: Array<[string, number]> = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  let rest = Math.round(seconds);
  for (const [label, size] of units) {
    if (rest >= size) {
      parts.push(`${Math.floor(rest / size)}${label}`);
      rest %= size;
    }
  }
  return parts.join('');
}
