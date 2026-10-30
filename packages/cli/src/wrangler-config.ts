/**
 * Wrangler configuration reading: `wrangler.jsonc` / `wrangler.json` (JSON with comments and trailing
 * commas) and `wrangler.toml` (a small TOML subset covering the keys HypDriv inspects).
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Strips comments and trailing commas from JSONC, respecting string literals. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === ',') {
      // trailing comma: skip whitespace/comments and look for a closing bracket
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j]!)) j++;
        if (text[j] === '/' && text[j + 1] === '/') {
          while (j < n && text[j] !== '\n') j++;
          continue;
        }
        if (text[j] === '/' && text[j + 1] === '*') {
          const end = text.indexOf('*/', j + 2);
          j = end === -1 ? n : end + 2;
          continue;
        }
        break;
      }
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Parses JSONC into a value. Throws a SyntaxError with the JSON parser's message. */
export function parseJsonc(text: string): JsonValue {
  return JSON.parse(stripJsonc(text)) as JsonValue;
}

// ---------------------------------------------------------------------------
// TOML subset
// ---------------------------------------------------------------------------

type TomlTable = { [key: string]: JsonValue };

function stripTomlComment(line: string): string {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function unescapeBasic(text: string): string {
  return text.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'u':
      case 'U':
        return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
}

class TomlValueParser {
  pos = 0;
  constructor(readonly text: string) {}

  skipWs(): void {
    while (this.pos < this.text.length && /[\s]/.test(this.text[this.pos]!)) this.pos++;
  }

  parseValue(): JsonValue {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new SyntaxError('unexpected end of value');
    if (ch === '"') return this.parseBasicString();
    if (ch === "'") return this.parseLiteralString();
    if (ch === '[') return this.parseArray();
    if (ch === '{') return this.parseInlineTable();
    const m =
      /^(true|false|[+-]?(?:inf|nan)|[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|\d{4}-\d{2}-\d{2}(?:[T ][0-9:.]+(?:Z|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(?:\.\d+)?)/.exec(
        this.text.slice(this.pos),
      );
    if (!m)
      throw new SyntaxError(`unsupported TOML value near "${this.text.slice(this.pos, this.pos + 20)}"`);
    this.pos += m[0].length;
    const token = m[0];
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(token) || /^\d{2}:\d{2}:\d{2}/.test(token)) return token;
    if (/inf|nan/.test(token)) return token;
    return Number(token.replace(/_/g, ''));
  }

  parseBasicString(): string {
    if (this.text.startsWith('"""', this.pos)) {
      const end = this.text.indexOf('"""', this.pos + 3);
      if (end === -1) throw new SyntaxError('unterminated multi-line string');
      const raw = this.text.slice(this.pos + 3, end).replace(/^\r?\n/, '');
      this.pos = end + 3;
      return unescapeBasic(raw);
    }
    let j = this.pos + 1;
    let raw = '';
    while (j < this.text.length && this.text[j] !== '"') {
      if (this.text[j] === '\\') {
        raw += this.text[j]! + (this.text[j + 1] ?? '');
        j += 2;
        continue;
      }
      raw += this.text[j];
      j++;
    }
    this.pos = j + 1;
    return unescapeBasic(raw);
  }

  parseLiteralString(): string {
    if (this.text.startsWith("'''", this.pos)) {
      const end = this.text.indexOf("'''", this.pos + 3);
      if (end === -1) throw new SyntaxError('unterminated multi-line literal string');
      const raw = this.text.slice(this.pos + 3, end).replace(/^\r?\n/, '');
      this.pos = end + 3;
      return raw;
    }
    const end = this.text.indexOf("'", this.pos + 1);
    if (end === -1) throw new SyntaxError('unterminated literal string');
    const raw = this.text.slice(this.pos + 1, end);
    this.pos = end + 1;
    return raw;
  }

  parseArray(): JsonValue[] {
    this.pos++; // [
    const out: JsonValue[] = [];
    for (;;) {
      this.skipWsAndComments();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipWsAndComments();
      if (this.text[this.pos] === ',') this.pos++;
      else if (this.text[this.pos] === ']') {
        this.pos++;
        return out;
      } else throw new SyntaxError('expected , or ] in array');
    }
  }

  skipWsAndComments(): void {
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++;
        continue;
      }
      return;
    }
  }

  parseInlineTable(): TomlTable {
    this.pos++; // {
    const out: TomlTable = {};
    this.skipWs();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWs();
      const key = this.parseKey();
      this.skipWs();
      if (this.text[this.pos] !== '=') throw new SyntaxError('expected = in inline table');
      this.pos++;
      const value = this.parseValue();
      setPath(out, key, value);
      this.skipWs();
      if (this.text[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === '}') {
        this.pos++;
        return out;
      }
      throw new SyntaxError('expected , or } in inline table');
    }
  }

  parseKey(): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === '"') parts.push(this.parseBasicString());
      else if (ch === "'") parts.push(this.parseLiteralString());
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.text.slice(this.pos));
        if (!m) throw new SyntaxError('invalid key');
        parts.push(m[0]);
        this.pos += m[0].length;
      }
      this.skipWs();
      if (this.text[this.pos] === '.') {
        this.pos++;
        continue;
      }
      return parts;
    }
  }
}

function setPath(table: TomlTable, path: string[], value: JsonValue): void {
  let cur = table;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const next = cur[key];
    if (next && typeof next === 'object' && !Array.isArray(next)) cur = next as TomlTable;
    else {
      const created: TomlTable = {};
      cur[key] = created;
      cur = created;
    }
  }
  cur[path[path.length - 1]!] = value;
}

function tableAt(root: TomlTable, path: string[]): TomlTable {
  let cur = root;
  for (const key of path) {
    const next = cur[key];
    if (Array.isArray(next)) {
      const last = next[next.length - 1];
      if (last && typeof last === 'object' && !Array.isArray(last)) {
        cur = last as TomlTable;
        continue;
      }
    }
    if (next && typeof next === 'object' && !Array.isArray(next)) cur = next as TomlTable;
    else {
      const created: TomlTable = {};
      cur[key] = created;
      cur = created;
    }
  }
  return cur;
}

/**
 * Parses the TOML subset wrangler configs use: tables, arrays of tables, dotted keys, strings,
 * numbers, booleans, (multi-line) arrays and inline tables.
 */
export function parseTomlSubset(text: string): TomlTable {
  const root: TomlTable = {};
  let current = root;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = stripTomlComment(lines[i]!).trim();
    if (!line) continue;
    const arrayTable = /^\[\[(.+)\]\]$/.exec(line);
    if (arrayTable) {
      const path = new TomlValueParser(arrayTable[1]!).parseKey();
      const parent = tableAt(root, path.slice(0, -1));
      const key = path[path.length - 1]!;
      const list = Array.isArray(parent[key]) ? (parent[key] as JsonValue[]) : [];
      const entry: TomlTable = {};
      list.push(entry);
      parent[key] = list;
      current = entry;
      continue;
    }
    const table = /^\[(.+)\]$/.exec(line);
    if (table) {
      current = tableAt(root, new TomlValueParser(table[1]!).parseKey());
      continue;
    }
    const eq = findAssignment(line);
    if (eq === -1) continue;
    const keyText = line.slice(0, eq);
    let valueText = line.slice(eq + 1).trim();
    // multi-line arrays / inline tables / strings: keep consuming lines until balanced
    while (!isBalanced(valueText) && i + 1 < lines.length) {
      i++;
      valueText += `\n${stripTomlComment(lines[i]!)}`;
    }
    line = valueText;
    try {
      const key = new TomlValueParser(keyText).parseKey();
      const value = new TomlValueParser(valueText).parseValue();
      setPath(current, key, value);
    } catch {
      // Unsupported constructs are skipped rather than failing the whole read.
    }
  }
  return root;
}

function findAssignment(line: string): number {
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inStr) {
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '=') return i;
  }
  return -1;
}

function isBalanced(text: string): boolean {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  let tripleQuote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (tripleQuote) {
      if (text.startsWith(tripleQuote, i)) {
        tripleQuote = null;
        i += 2;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\\' && inStr === '"') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      tripleQuote = text.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth <= 0 && !inStr && !tripleQuote;
}

// ---------------------------------------------------------------------------
// Normalised wrangler config
// ---------------------------------------------------------------------------

export interface WranglerBinding {
  binding?: string;
  name?: string;
  class_name?: string;
  service?: string;
  dataset?: string;
  id?: string;
  bucket_name?: string;
  queue?: string;
  namespace_id?: string;
  [key: string]: JsonValue | undefined;
}

export interface WranglerConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  compatibility_flags: string[];
  assets?: { directory?: string; binding?: string; run_worker_first?: boolean | string[] };
  triggers?: { crons?: string[] };
  observability?: { enabled?: boolean; logs?: { enabled?: boolean } };
  services: WranglerBinding[];
  kv_namespaces: WranglerBinding[];
  r2_buckets: WranglerBinding[];
  d1_databases: WranglerBinding[];
  durable_objects: { bindings: WranglerBinding[] };
  migrations: Array<{
    tag?: string;
    new_classes?: string[];
    new_sqlite_classes?: string[];
    deleted_classes?: string[];
  }>;
  analytics_engine_datasets: WranglerBinding[];
  ratelimits: WranglerBinding[];
  queues: { producers: WranglerBinding[]; consumers: WranglerBinding[] };
  images?: { binding?: string };
  ai?: { binding?: string };
  vars: Record<string, JsonValue>;
  placement?: { mode?: string };
  env: Record<string, unknown>;
  /** The raw parsed document. */
  raw: Record<string, JsonValue>;
}

function asArray(value: unknown): WranglerBinding[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === 'object') as WranglerBinding[]) : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Normalises a parsed wrangler document (either format) into a predictable shape. */
export function normalizeWranglerConfig(doc: Record<string, JsonValue>): WranglerConfig {
  const obj = (v: unknown): Record<string, JsonValue> | undefined =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, JsonValue>) : undefined;
  const assets = obj(doc.assets);
  const triggers = obj(doc.triggers);
  const observability = obj(doc.observability);
  const durable = obj(doc.durable_objects);
  const queues = obj(doc.queues);
  const images = obj(doc.images);
  const ai = obj(doc.ai);
  const placement = obj(doc.placement);
  return {
    ...(typeof doc.name === 'string' ? { name: doc.name } : {}),
    ...(typeof doc.main === 'string' ? { main: doc.main } : {}),
    ...(typeof doc.compatibility_date === 'string' ? { compatibility_date: doc.compatibility_date } : {}),
    compatibility_flags: asStringArray(doc.compatibility_flags),
    ...(assets
      ? {
          assets: {
            ...(typeof assets.directory === 'string' ? { directory: assets.directory } : {}),
            ...(typeof assets.binding === 'string' ? { binding: assets.binding } : {}),
            ...(assets.run_worker_first !== undefined
              ? { run_worker_first: assets.run_worker_first as boolean | string[] }
              : {}),
          },
        }
      : {}),
    ...(triggers ? { triggers: { crons: asStringArray(triggers.crons) } } : {}),
    ...(observability
      ? {
          observability: {
            ...(typeof observability.enabled === 'boolean' ? { enabled: observability.enabled } : {}),
            ...(obj(observability.logs) ? { logs: obj(observability.logs) as { enabled?: boolean } } : {}),
          },
        }
      : {}),
    services: asArray(doc.services),
    kv_namespaces: asArray(doc.kv_namespaces),
    r2_buckets: asArray(doc.r2_buckets),
    d1_databases: asArray(doc.d1_databases),
    durable_objects: { bindings: asArray(durable?.bindings) },
    migrations: asArray(doc.migrations) as WranglerConfig['migrations'],
    analytics_engine_datasets: asArray(doc.analytics_engine_datasets),
    ratelimits: asArray(doc.ratelimits),
    queues: { producers: asArray(queues?.producers), consumers: asArray(queues?.consumers) },
    ...(images
      ? { images: { ...(typeof images.binding === 'string' ? { binding: images.binding } : {}) } }
      : {}),
    ...(ai ? { ai: { ...(typeof ai.binding === 'string' ? { binding: ai.binding } : {}) } } : {}),
    vars: obj(doc.vars) ?? {},
    ...(placement
      ? { placement: { ...(typeof placement.mode === 'string' ? { mode: placement.mode } : {}) } }
      : {}),
    env: obj(doc.env) ?? {},
    raw: doc,
  };
}

export type WranglerFormat = 'jsonc' | 'json' | 'toml';

/** Parses the text of a wrangler config file in any supported format. Throws on syntax errors. */
export function parseWranglerConfig(text: string, format: WranglerFormat): WranglerConfig {
  const doc = format === 'toml' ? parseTomlSubset(text) : parseJsonc(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc))
    throw new SyntaxError('wrangler config must be an object');
  return normalizeWranglerConfig(doc as Record<string, JsonValue>);
}

/** Binding names declared anywhere in the config (what `env` will contain at run time). */
export function declaredBindingNames(config: WranglerConfig): string[] {
  const names = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string' && v) names.add(v);
  };
  for (const b of config.services) add(b.binding);
  for (const b of config.kv_namespaces) add(b.binding);
  for (const b of config.r2_buckets) add(b.binding);
  for (const b of config.d1_databases) add(b.binding);
  for (const b of config.durable_objects.bindings) add(b.name);
  for (const b of config.analytics_engine_datasets) add(b.binding);
  for (const b of config.ratelimits) add(b.name);
  for (const b of config.queues.producers) add(b.binding);
  add(config.assets?.binding);
  add(config.images?.binding);
  add(config.ai?.binding);
  for (const k of Object.keys(config.vars)) names.add(k);
  return [...names];
}
