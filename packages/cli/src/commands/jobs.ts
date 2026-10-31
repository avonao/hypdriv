import { rawList, UsageError } from '../args';
import { DESKTOP_UA, joinUrl, normalizeBaseUrl } from '../audit/http';
import { accessHeaders } from '../audit/token';
import { CliError, createContext } from '../context';
import { loadSecurity, missingExport } from '../integrations';
import { millis } from '../ui';
import { readSecret } from '../util/secrets';
import { defineCommand } from './types';

export { readSecret } from '../util/secrets';

export const jobsCommand = defineCommand({
  name: 'jobs',
  summary: 'Run a configured job against a deployment with a signed internal request',
  usage: 'hypdriv jobs <run|list> [name] --url <base> [--payload <json>] [--method GET|POST]',
  options: {
    url: { type: 'string', value: '<base>', description: 'Base URL of the deployment' },
    payload: { type: 'string', value: '<json>', description: 'JSON payload sent as { job, payload }' },
    method: {
      type: 'string',
      value: '<method>',
      description: 'Override the method (default: the job config; GET on Vercel, as Vercel Cron calls it)',
    },
    timeout: { type: 'string', value: '<ms>', description: 'Request timeout (default: the job timeout)' },
    header: {
      type: 'string',
      value: '<name: value>',
      description:
        'Extra request header for a gateway in front of the deployment (repeatable; also HYPDRIV_ACCESS_HEADERS, CF_ACCESS_CLIENT_ID/SECRET, VERCEL_AUTOMATION_BYPASS_SECRET)',
      multiple: true,
    },
  },
  subcommands: [
    { name: 'list', summary: 'List configured cron jobs, queues and the email route' },
    {
      name: 'run <name>',
      summary: 'Sign and send the job request (HYPDRIV_INTERNAL_SECRET; CRON_SECRET bearer on Vercel)',
    },
  ],
  examples: [
    'hypdriv jobs list',
    'hypdriv jobs run digest --url http://localhost:8787',
    'hypdriv jobs run digest --url https://www.example.com --payload \'{"dryRun":true}\'',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const sub = args.positionals[0];
    const config = await ctx.loadConfig();
    if (config.error) throw new CliError(`hypdriv.config failed to load: ${config.error}`);
    const jobs = config.resolved.jobs;
    if (sub === 'list' || sub === undefined) {
      const cron = Object.entries(jobs.cron).map(([name, j]) => ({
        name,
        kind: 'cron',
        schedule: j.cron,
        path: j.path,
        method: j.method,
      }));
      const queues = Object.entries(jobs.queues).map(([name, q]) => ({
        name,
        kind: 'queue',
        schedule: null,
        path: q.path,
        method: 'POST',
      }));
      const email = jobs.email
        ? [{ name: 'email', kind: 'email', schedule: null, path: jobs.email.path, method: 'POST' }]
        : [];
      const all = [...cron, ...queues, ...email];
      if (args.json) ui.printJson({ jobs: all });
      else if (!all.length)
        ui.note('No jobs configured (jobs.cron / jobs.queues / jobs.email in hypdriv.config.ts).');
      else
        ui.table(
          all.map((j) => [j.name, j.kind, j.schedule ?? '—', j.method, j.path]),
          { columns: ['name', 'kind', 'schedule', 'method', 'path'] },
        );
      return 0;
    }
    if (sub !== 'run') throw new UsageError('jobs needs a subcommand: run <name> or list');
    const name = args.positionals[1];
    if (!name) throw new UsageError('jobs run needs a job name (see `hypdriv jobs list`)');
    const base = normalizeBaseUrl(args.string('url'));
    if (!base) throw new UsageError('--url <base> is required');
    const cronJob = jobs.cron[name];
    const queueJob = jobs.queues[name];
    const path = cronJob?.path ?? queueJob?.path ?? (name === 'email' ? jobs.email?.path : undefined);
    if (!path)
      throw new CliError(
        `unknown job "${name}"; configured: ${[...Object.keys(jobs.cron), ...Object.keys(jobs.queues), ...(jobs.email ? ['email'] : [])].join(', ') || 'none'}`,
      );
    const platform = ctx.project({ scan: false }).platform;
    const vercelCron = platform === 'vercel' && Boolean(cronJob);
    const method = (
      args.string('method') ?? (vercelCron ? 'GET' : (cronJob?.method ?? 'POST'))
    ).toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new UsageError('--method must be GET or POST');
    let payload: unknown = null;
    const rawPayload = args.string('payload');
    if (rawPayload !== undefined) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        throw new UsageError('--payload must be valid JSON');
      }
    }
    const secretName = config.resolved.security.internalAuth.secretEnv;
    const secret = readSecret(ctx.root, io.env, secretName);
    const cronSecret = vercelCron ? readSecret(ctx.root, io.env, 'CRON_SECRET') : null;
    if (!secret && !cronSecret)
      throw new CliError(
        `${secretName} is not set (environment, .dev.vars or .env.local)${vercelCron ? ' and neither is CRON_SECRET' : ''}; the job route rejects unsigned requests.`,
      );
    const url = new URL(joinUrl(base, path));
    if (method === 'GET') url.searchParams.set('job', name);
    const headers: Record<string, string> = {
      ...accessHeaders(ctx.root, io.env, rawList(args, 'header')),
      'user-agent': DESKTOP_UA,
      'x-hypdriv-job': name,
      accept: 'application/json',
    };
    if (cronSecret) headers.authorization = `Bearer ${cronSecret.value}`;
    const body =
      method === 'POST'
        ? JSON.stringify({ job: name, ...(cronJob ? { cron: cronJob.cron } : {}), payload, manual: true })
        : undefined;
    if (body) headers['content-type'] = 'application/json';
    let request = new Request(url, { method, headers, ...(body !== undefined ? { body } : {}) });
    if (secret) {
      const security = await loadSecurity();
      if (!security?.signing?.signInternalRequest)
        throw new CliError(missingExport('@hypdriv/security', 'signing.signInternalRequest'));
      request = await security.signing.signInternalRequest(request, secret.value, io.date().getTime());
    }
    const timeoutMs = args.number('timeout', cronJob?.timeoutMs ?? 25_000, { min: 100 });
    const started = io.now();
    let res: Response;
    try {
      res = await io.fetch(request, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new CliError(`request to ${url.href} failed: ${(err as Error).message}`);
    }
    const ms = io.now() - started;
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const ok = res.status >= 200 && res.status < 300;
    if (args.json)
      ui.printJson({
        job: name,
        url: url.href,
        method,
        status: res.status,
        ok,
        ms: Math.round(ms),
        signedWith: [secret ? secretName : null, cronSecret ? 'CRON_SECRET' : null].filter(Boolean),
        response: json ?? text,
      });
    else {
      ui.status(
        ok ? 'pass' : 'fail',
        `${method} ${url.pathname} → ${res.status}`,
        `${millis(ms)} · signed with ${[secret ? `${secretName} (${secret.source})` : null, cronSecret ? `CRON_SECRET (${cronSecret.source})` : null].filter(Boolean).join(' + ')}`,
      );
      ui.line(json !== null ? JSON.stringify(json, null, 2) : text.slice(0, 4000));
    }
    return ok ? 0 : 1;
  },
});
