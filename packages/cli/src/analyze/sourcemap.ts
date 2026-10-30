/**
 * Source map v3 decoding (base64 VLQ) and byte attribution of a generated bundle to its sources.
 * No dependencies: the decoder is ~40 lines and the attribution a single pass over the mappings.
 */

export interface SourceMapV3 {
  version: number;
  file?: string;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: Array<string | null>;
  names?: string[];
  mappings: string;
  /** Indexed source maps are not supported (wrangler/esbuild do not emit them). */
  sections?: unknown[];
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) LOOKUP[BASE64.charCodeAt(i)] = i;

/** Decodes every VLQ value in a segment (`AAgBC` → `[0, 0, 16, 1]`). Throws on invalid characters. */
export function decodeVlq(segment: string): number[] {
  const out: number[] = [];
  let value = 0;
  let shift = 0;
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    const digit = code < 128 ? LOOKUP[code]! : -1;
    if (digit < 0) throw new SyntaxError(`invalid base64 VLQ character "${segment[i]}"`);
    const continuation = digit & 32;
    // Arithmetic instead of bit shifts: values beyond 2^31 must not wrap.
    value += (digit & 31) * 2 ** shift;
    if (continuation) {
      shift += 5;
      continue;
    }
    const negative = value % 2 === 1;
    value = Math.floor(value / 2);
    out.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new SyntaxError('truncated VLQ sequence');
  return out;
}

/** Encodes numbers as a VLQ segment (used by tests and tooling). */
export function encodeVlq(values: number[]): string {
  let out = '';
  for (const value of values) {
    let vlq = value < 0 ? -value * 2 + 1 : value * 2;
    do {
      let digit = vlq % 32;
      vlq = Math.floor(vlq / 32);
      if (vlq > 0) digit += 32;
      out += BASE64[digit];
    } while (vlq > 0);
  }
  return out;
}

/** One decoded mapping segment with absolute positions. */
export interface MappingSegment {
  generatedColumn: number;
  source: number | null;
  sourceLine: number;
  sourceColumn: number;
  name: number | null;
}

/** Decodes `mappings` into absolute segments per generated line. Malformed segments are skipped. */
export function decodeMappings(mappings: string): MappingSegment[][] {
  const lines: MappingSegment[][] = [];
  let source = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  let name = 0;
  for (const line of mappings.split(';')) {
    const segments: MappingSegment[] = [];
    let generatedColumn = 0;
    if (line) {
      for (const raw of line.split(',')) {
        if (!raw) continue;
        let fields: number[];
        try {
          fields = decodeVlq(raw);
        } catch {
          continue;
        }
        if (fields.length !== 1 && fields.length !== 4 && fields.length !== 5) continue;
        generatedColumn += fields[0]!;
        if (fields.length === 1) {
          segments.push({ generatedColumn, source: null, sourceLine: 0, sourceColumn: 0, name: null });
          continue;
        }
        source += fields[1]!;
        sourceLine += fields[2]!;
        sourceColumn += fields[3]!;
        if (fields.length === 5) name += fields[4]!;
        segments.push({
          generatedColumn,
          source,
          sourceLine,
          sourceColumn,
          name: fields.length === 5 ? name : null,
        });
      }
    }
    lines.push(segments);
  }
  return lines;
}

export interface Attribution {
  /** Bytes per source index. */
  bySource: Map<number, number>;
  /** Bytes of generated code without a mapping (runtime glue, whitespace, newlines). */
  unmapped: number;
  /** Generated code length that was attributed (`code.length`). */
  total: number;
}

/**
 * Attributes the generated code to sources: each segment owns the bytes from its column to the next
 * segment's column (or the end of the line). Columns beyond the line length are clamped.
 */
export function attributeBytes(code: string, map: Pick<SourceMapV3, 'mappings'>): Attribution {
  const bySource = new Map<number, number>();
  let unmapped = 0;
  const lines = code.split('\n');
  const decoded = decodeMappings(map.mappings);
  for (let i = 0; i < lines.length; i++) {
    const lineLength = lines[i]!.length;
    const newline = i < lines.length - 1 ? 1 : 0;
    const segments = decoded[i];
    if (!segments || segments.length === 0) {
      unmapped += lineLength + newline;
      continue;
    }
    const ordered = [...segments].sort((a, b) => a.generatedColumn - b.generatedColumn);
    const firstCol = Math.min(ordered[0]!.generatedColumn, lineLength);
    unmapped += firstCol + newline;
    for (let j = 0; j < ordered.length; j++) {
      const start = Math.min(ordered[j]!.generatedColumn, lineLength);
      const next = ordered[j + 1];
      const end = next ? Math.min(next.generatedColumn, lineLength) : lineLength;
      const bytes = Math.max(0, end - start);
      if (bytes === 0) continue;
      const src = ordered[j]!.source;
      if (src === null) unmapped += bytes;
      else bySource.set(src, (bySource.get(src) ?? 0) + bytes);
    }
  }
  return { bySource, unmapped, total: code.length };
}

/** Parses a JSON source map, rejecting indexed maps and other versions. */
export function parseSourceMap(text: string): SourceMapV3 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const map = parsed as SourceMapV3;
  if (map.version !== 3 || !Array.isArray(map.sources) || typeof map.mappings !== 'string') return null;
  if (Array.isArray(map.sections)) return null;
  return map;
}

/** Resolves a source path against `sourceRoot`, normalising separators. */
export function sourcePath(map: SourceMapV3, index: number): string {
  const raw = map.sources[index] ?? `<source ${index}>`;
  const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, '/') : '';
  return `${root}${raw}`.replace(/\\/g, '/');
}
