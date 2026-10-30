import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** Minimal file-system abstraction so manifest derivation is testable against fixtures. */
export interface AdapterFs {
  exists(path: string): boolean;
  readText(path: string): string;
  readBytes(path: string): Uint8Array;
  size(path: string): number;
  /** Lists files recursively (absolute paths). */
  listFiles(dir: string): string[];
  writeText(path: string, text: string): void;
  gzipSize(path: string): number;
}

export function createNodeFs(): AdapterFs {
  const gzipCache = new Map<string, number>();
  return {
    exists: (p) => existsSync(p),
    readText: (p) => readFileSync(p, 'utf8'),
    readBytes: (p) => new Uint8Array(readFileSync(p)),
    size: (p) => statSync(p).size,
    listFiles(dir) {
      const out: string[] = [];
      const walk = (d: string) => {
        let entries: import('node:fs').Dirent[];
        try {
          entries = readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) out.push(full);
        }
      };
      walk(dir);
      return out;
    },
    writeText(p, text) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    gzipSize(p) {
      const hit = gzipCache.get(p);
      if (hit !== undefined) return hit;
      const n = gzipSync(readFileSync(p), { level: 6 }).length;
      gzipCache.set(p, n);
      return n;
    },
  };
}

/** Rewrites `<projectDir>` placeholders in captured fixture contexts. */
export function rerootPaths<T>(value: T, projectDir: string): T {
  const text = JSON.stringify(value).split('<projectDir>').join(projectDir.replace(/\\/g, '\\\\'));
  return JSON.parse(text) as T;
}
