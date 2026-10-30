import { packageOf } from './packages';

/** The esbuild metafile shape (`handler.mjs.meta.json` written by OpenNext). */
export interface EsbuildMetafile {
  inputs: Record<
    string,
    { bytes: number; imports?: Array<{ path: string; kind?: string; external?: boolean }> }
  >;
  outputs: Record<
    string,
    {
      bytes: number;
      inputs: Record<string, { bytesInOutput: number }>;
      entryPoint?: string;
      imports?: Array<{ path: string; kind?: string }>;
    }
  >;
}

export interface MetafileInput {
  path: string;
  /** Bytes of the input as read by esbuild. */
  bytes: number;
  /** Bytes the input contributed to outputs (after minification / tree shaking). */
  bytesInOutput: number;
}

export interface MetafileSummary {
  file: string;
  inputs: number;
  totalInputBytes: number;
  totalOutputBytes: number;
  largestInputs: MetafileInput[];
  byPackage: Array<{ name: string; bytes: number; share: number }>;
}

/** Validates the parsed JSON of a metafile. */
export function parseMetafile(json: unknown): EsbuildMetafile | null {
  if (!json || typeof json !== 'object') return null;
  const m = json as Partial<EsbuildMetafile>;
  if (!m.inputs || typeof m.inputs !== 'object') return null;
  return { inputs: m.inputs, outputs: m.outputs && typeof m.outputs === 'object' ? m.outputs : {} };
}

/** Summarises a metafile: largest inputs (by output contribution) and package totals. */
export function summarizeMetafile(
  meta: EsbuildMetafile,
  file: string,
  options: { limit?: number; packageLimit?: number } = {},
): MetafileSummary {
  const limit = options.limit ?? 15;
  const contribution = new Map<string, number>();
  let totalOutputBytes = 0;
  for (const output of Object.values(meta.outputs)) {
    totalOutputBytes += output.bytes ?? 0;
    for (const [path, input] of Object.entries(output.inputs ?? {})) {
      contribution.set(path, (contribution.get(path) ?? 0) + (input.bytesInOutput ?? 0));
    }
  }
  const inputs: MetafileInput[] = Object.entries(meta.inputs).map(([path, input]) => ({
    path,
    bytes: input.bytes ?? 0,
    bytesInOutput: contribution.get(path) ?? 0,
  }));
  const metric = (i: MetafileInput) => (contribution.size ? i.bytesInOutput : i.bytes);
  const largestInputs = [...inputs].sort((a, b) => metric(b) - metric(a)).slice(0, limit);
  const totalInputBytes = inputs.reduce((n, i) => n + i.bytes, 0);
  const packages = new Map<string, number>();
  let attributedTotal = 0;
  for (const input of inputs) {
    const value = metric(input);
    attributedTotal += value;
    const pkg = packageOf(input.path);
    const key = pkg ? pkg.name : '(app)';
    packages.set(key, (packages.get(key) ?? 0) + value);
  }
  const byPackage = [...packages.entries()]
    .map(([name, bytes]) => ({ name, bytes, share: attributedTotal ? bytes / attributedTotal : 0 }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, options.packageLimit ?? 15);
  return { file, inputs: inputs.length, totalInputBytes, totalOutputBytes, largestInputs, byPackage };
}
