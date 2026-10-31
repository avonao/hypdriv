import { rawList, UsageError } from '../args';
import { normalizeBaseUrl } from '../audit/http';
import { accessHeaders } from '../audit/token';
import { createContext } from '../context';
import { loadSecurity, missingExport } from '../integrations';
import { readSecret } from '../util/secrets';
import { defineCommand } from './types';

/** Header that carries the purge token (`HEADER.purgeToken` in `@hypdriv/core`). */
export const PURGE_TOKEN_HEADER = 'x-hypdriv-purge';

/** What the endpoint answers, in words an operator can act on. */
export function explainPurgeFailure(status: number, secretName: string, prefix: string): string {
  if (status === 404)
    return `${prefix}/purge does not exist for this request: ${secretName} is not set on the Worker that answered (or differs from the local one), the deployed @hypdriv packages predate hypdriv purge, or the request reached a different application (on a fleet, a router sends ${prefix}/** to one area only).`;
  if (status === 409)
    return 'The application has no edge cache to purge (cache.edge is off, or the Worker never registered one).';
  if (status === 413) return 'The request is larger than 64 KB: send fewer tags and paths per call.';
  if (status === 400)
    return 'The endpoint rejected the request body (at most 200 entries; paths start with "/").';
  if (status === 401 || status === 403 || (status >= 300 && status < 400))
    return 'A gateway in front of the application answered (site gate, Cloudflare Access, WAF rule): pass its credentials with --header "name: value" or HYPDRIV_ACCESS_HEADERS.';
  if (status === 0) return 'The request did not complete.';
  return `Unexpected status ${status}.`;
}

interface PurgeResponse {
  ok?: boolean;
  tags?: number;
  urls?: number;
  entriesRemoved?: number;
  error?: string;
}

export const purgeCommand = defineCommand({
  name: 'purge',
  summary: 'Purge the edge cache of a deployment by tag or path (all cache tiers, signed request)',
  usage: 'hypdriv purge --url <base> (--tag <tag> | --path </path> | --all) [--header "name: value"]',
  options: {
    url: { type: 'string', value: '<base>', description: 'Base URL of the deployment (its host is signed)' },
    tag: {
      type: 'string',
      value: '<tag>',
      description: 'Cache tag to purge, e.g. path:/pricing, route:<id>, build:<id> (repeatable)',
      multiple: true,
    },
    path: {
      type: 'string',
      value: '</path>',
      description: 'Path (or absolute URL) to purge, with every variant of it (repeatable)',
      multiple: true,
    },
    all: {
      type: 'boolean',
      description:
        'Purge every cached page of this build: the tag build:<buildId> of the local manifest (.hypdriv/manifest.js)',
    },
    timeout: { type: 'string', value: '<ms>', description: 'Request timeout', default: '15000' },
    header: {
      type: 'string',
      value: '<name: value>',
      description:
        'Extra request header for a gateway in front of the deployment, e.g. a site-gate cookie (repeatable; also HYPDRIV_ACCESS_HEADERS, CF_ACCESS_CLIENT_ID/SECRET, VERCEL_AUTOMATION_BYPASS_SECRET)',
      multiple: true,
    },
  },
  examples: [
    'hypdriv purge --url https://www.example.com --path /pricing --path /blog',
    'hypdriv purge --url https://www.example.com --tag route:/blog/[slug]',
    'hypdriv purge --url https://www.example.com --all --header "cookie: gate=…"',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required');
    const tags = rawList(args, 'tag');
    const targets = rawList(args, 'path');
    const urls = targets.filter((t) => /^https?:\/\//i.test(t));
    const paths = targets.filter((t) => !/^https?:\/\//i.test(t));
    for (const path of paths)
      if (!path.startsWith('/'))
        throw new UsageError(`--path "${path}" must start with "/" (or be an absolute URL)`);
    const config = await ctx.loadConfig();
    if (args.boolean('all')) {
      const manifest = ctx.manifest();
      if (!manifest)
        throw new UsageError(
          '--all needs the local build manifest (.hypdriv/manifest.js): run a build first, or give --tag build:<buildId>',
        );
      tags.push(`build:${manifest.buildId}`);
    }
    if (!tags.length && !paths.length && !urls.length)
      throw new UsageError('give at least one --tag, --path or --all');

    const secretName = config.resolved.security.internalAuth.secretEnv;
    const secret = readSecret(ctx.root, io.env, secretName);
    if (!secret)
      throw new UsageError(
        `${secretName} is not set (environment, .dev.vars or .env.local): purging is authorised with the deployment's internal secret`,
      );
    const security = await loadSecurity();
    if (!security?.signPurgeToken) throw new UsageError(missingExport('@hypdriv/security', 'signPurgeToken'));
    const token = await security.signPurgeToken(secret.value, {
      host: new URL(base).hostname,
      ttlSeconds: 120,
      now: io.date().getTime(),
    });
    const prefix = config.resolved.cloudflare.internalPathPrefix;
    const endpoint = `${base}${prefix}/purge`;
    const payload = {
      ...(tags.length ? { tags: [...new Set(tags)] } : {}),
      ...(paths.length ? { paths: [...new Set(paths)] } : {}),
      ...(urls.length ? { urls: [...new Set(urls)] } : {}),
    };
    const timeoutMs = args.number('timeout', 15_000, { min: 100 });
    if (!args.json) {
      ui.heading(`Purging ${base}`);
      ui.note(`${describe(payload)}; request signed with ${secretName} from ${secret.source}.`);
    }

    let status = 0;
    let text = '';
    let error: string | null = null;
    try {
      const res = await io.fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          ...accessHeaders(ctx.root, io.env, rawList(args, 'header')),
          'content-type': 'application/json',
          'user-agent': 'Hypdriv-CLI',
          [PURGE_TOKEN_HEADER]: token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      error =
        e.name === 'TimeoutError'
          ? `timed out after ${timeoutMs} ms`
          : e.cause?.code
            ? `${e.message} (${e.cause.code})`
            : e.message;
    }
    let body: PurgeResponse | null = null;
    try {
      body = text ? (JSON.parse(text) as PurgeResponse) : null;
    } catch {
      body = null;
    }
    const ok = !error && status === 200 && body?.ok === true;
    const reason = error ?? (ok ? null : explainPurgeFailure(status, secretName, prefix));
    if (args.json) {
      ui.printJson({ url: base, endpoint, status, ok, request: payload, response: body, error: reason });
    } else if (ok) {
      ui.status(
        'pass',
        `Purged ${body?.tags ?? 0} tag(s) and ${body?.urls ?? 0} URL(s); ${body?.entriesRemoved ?? 0} cache entr${body?.entriesRemoved === 1 ? 'y' : 'ies'} removed.`,
      );
      ui.note(
        'A purge also stops re-caching those tags for 5 seconds (purge grace); the next requests render fresh and the page is cached again after that.',
      );
    } else {
      ui.status('fail', `${endpoint} answered ${status || 'nothing'}`, reason ?? undefined);
    }
    return ok ? 0 : 1;
  },
});

function describe(payload: { tags?: string[]; paths?: string[]; urls?: string[] }): string {
  const parts: string[] = [];
  if (payload.tags?.length)
    parts.push(`${payload.tags.length} tag(s): ${payload.tags.slice(0, 5).join(', ')}`);
  if (payload.paths?.length)
    parts.push(`${payload.paths.length} path(s): ${payload.paths.slice(0, 5).join(', ')}`);
  if (payload.urls?.length) parts.push(`${payload.urls.length} URL(s)`);
  return parts.join('; ');
}
