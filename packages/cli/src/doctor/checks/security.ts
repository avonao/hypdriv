import { join } from 'node:path';
import { loadSecurityNode } from '../../integrations';
import { exists, rel } from '../../util/fs';
import { type Check, type CheckContext, fail, info, pass, skip, warn } from '../types';
import { variableSource } from './vercel';

function secretAvailable(ctx: CheckContext, name: string): string | null {
  return variableSource(ctx, name);
}

function setHint(ctx: CheckContext, name: string): string {
  if (ctx.project.platform === 'vercel') return `vercel env add ${name}`;
  if (ctx.project.platform === 'cloudflare')
    return `wrangler secret put ${name}; add it to .dev.vars for preview`;
  return `set ${name} in the server environment`;
}

function sessionsUsed(ctx: CheckContext): boolean {
  const s = ctx.config.resolved.security;
  if (s.csrf) return true;
  if (s.rateLimit.some((p) => p.keys.includes('session'))) return true;
  return false;
}

export const securityChecks: Check[] = [
  {
    id: 'security.secrets-scan',
    title: 'Secrets in client assets',
    category: 'security',
    severity: 'error',
    async run(ctx) {
      const scan = ctx.config.resolved.security.secretsScan;
      if (!scan) return skip('secretsScan is disabled in hypdriv.config.');
      const dirs = [join(ctx.root, '.next', 'static'), join(ctx.root, 'public')].filter((d) => exists(d));
      if (!dirs.some((d) => d.endsWith('static')))
        return skip('No .next/static build output; run `next build` first.');
      const mod = await loadSecurityNode();
      if (!mod?.scanSecrets)
        return skip('@hypdriv/security/node scanSecrets is unavailable in this installation.');
      const findings = await mod.scanSecrets({
        dirs,
        patterns: scan.patterns,
        env: ctx.io.env,
        publicPrefixes: scan.publicPrefixes,
        envAllowlist: scan.envAllowlist,
        minValueLength: scan.minValueLength,
      });
      if (!findings.length)
        return pass(`No credential-like strings in ${dirs.map((d) => rel(ctx.root, d)).join(', ')}.`);
      const details = findings.map((f) => `${rel(ctx.root, f.file)}:${f.line}  ${f.id} (${f.snippet})`);
      if (findings.some((f) => f.severity === 'error'))
        return fail(`${findings.length} secret-like finding(s) in client assets.`, { details });
      return warn(`${findings.length} possible secret(s) in client assets.`, { details });
    },
  },
  {
    id: 'security.session-secret',
    title: 'HYPDRIV_SESSION_SECRET',
    category: 'security',
    severity: 'warn',
    run(ctx) {
      const name = ctx.config.resolved.security.sessions.secretEnv;
      const where = secretAvailable(ctx, name);
      if (!sessionsUsed(ctx)) {
        if (where) return pass(`${name} available (${where}).`);
        return info(
          `${name} is not set; needed once you use encrypted sessions or CSRF tokens (${setHint(ctx, name)}).`,
        );
      }
      if (!where)
        return warn(
          `${name} is not set in the environment, .env files or .dev.vars but sessions/CSRF are configured (${setHint(ctx, name)}).`,
        );
      return pass(`${name} available (${where}).`);
    },
  },
  {
    id: 'security.internal-secret',
    title: 'HYPDRIV_INTERNAL_SECRET',
    category: 'security',
    platforms: ['cloudflare', 'vercel', 'node'],
    severity: 'warn',
    run(ctx) {
      const jobs = ctx.config.resolved.jobs;
      const vercel = ctx.project.platform === 'vercel';
      // On Vercel, Vercel Cron authenticates with CRON_SECRET; the internal secret signs enqueue()'s
      // consumer-route fallback, `hypdriv jobs run` and the audit token.
      const used = vercel
        ? Object.keys(jobs.queues).length > 0 || jobs.email !== null
        : Object.keys(jobs.cron).length > 0 || Object.keys(jobs.queues).length > 0 || jobs.email !== null;
      const name = ctx.config.resolved.security.internalAuth.secretEnv;
      const where = secretAvailable(ctx, name);
      if (!used)
        return where
          ? pass(`${name} available (${where}).`)
          : skip(
              vercel
                ? 'No queue or email jobs configured (Vercel Cron uses CRON_SECRET).'
                : 'No cron, queue or email jobs configured.',
            );
      if (!where)
        return warn(
          vercel
            ? `${name} is not set but queues are configured; enqueue() signs its consumer-route fallback with it (${setHint(ctx, name)}).`
            : `${name} is not set but jobs are configured; the scheduled/queue handlers sign requests with it (${setHint(ctx, name)}).`,
        );
      return pass(`${name} available (${where}).`);
    },
  },
  {
    id: 'security.dashboard-token',
    title: 'Vitals dashboard access token',
    category: 'security',
    severity: 'warn',
    run(ctx) {
      const dashboard = ctx.config.resolved.observe.vitals?.dashboard;
      if (!dashboard) return skip('observe.vitals.dashboard is off.');
      const name = dashboard.tokenEnv;
      const where = secretAvailable(ctx, name);
      if (!where)
        return warn(
          `${name} is not set, so /_hypdriv/dash answers 404 to everyone (${setHint(ctx, name)}; \`openssl rand -base64 32\` makes a good one).`,
        );
      const length = ctx.project.devVars.lengths[name];
      if (length !== undefined && length > 0 && length < 24)
        return warn(
          `${name} in .dev.vars is ${length} characters; the dashboard needs at least 24 and stays hidden otherwise.`,
        );
      return pass(`${name} available (${where}); /_hypdriv/dash is token protected.`);
    },
  },
  {
    id: 'security.dashboard-source',
    title: 'Vitals dashboard data source',
    category: 'security',
    severity: 'info',
    run(ctx) {
      const vitals = ctx.config.resolved.observe.vitals;
      const dashboard = vitals?.dashboard;
      if (!vitals || !dashboard) return skip('observe.vitals.dashboard is off.');
      if (ctx.project.platform !== 'cloudflare')
        return info(
          `The dashboard shows the measurements this server instance receives (Analytics Engine is a Cloudflare feature); on ${ctx.project.platform ?? 'this platform'} use Speed Insights or a log drain for site-wide numbers.`,
        );
      const missing = [
        [dashboard.accountIdEnv, secretAvailable(ctx, dashboard.accountIdEnv)],
        [dashboard.apiTokenEnv, secretAvailable(ctx, dashboard.apiTokenEnv)],
        ...(dashboard.dataset ? [] : [[dashboard.datasetEnv, secretAvailable(ctx, dashboard.datasetEnv)]]),
      ]
        .filter(([, where]) => !where)
        .map(([name]) => name);
      if (missing.length)
        return info(
          `Set ${missing.join(', ')} for durable, site-wide numbers from Analytics Engine; until then the dashboard shows the measurements one Worker instance holds in memory.`,
        );
      if (vitals.sink !== 'analytics-engine')
        return warn(
          "The dashboard reads Analytics Engine, but observe.vitals.sink is not 'analytics-engine', so the dataset receives no measurements.",
        );
      return pass('The dashboard reads Workers Analytics Engine through its SQL API.');
    },
  },
  {
    id: 'security.secret-strength',
    title: 'Secret length in .dev.vars',
    category: 'security',
    platforms: ['cloudflare'],
    severity: 'warn',
    run(ctx) {
      const dv = ctx.project.devVars;
      if (!dv.file) return skip('no .dev.vars.');
      const weak = Object.entries(dv.lengths).filter(
        ([k, len]) => /SECRET|TOKEN|KEY/.test(k) && len > 0 && len < 32,
      );
      if (weak.length)
        return warn(
          `Short secrets in .dev.vars: ${weak.map(([k, len]) => `${k} (${len} chars)`).join(', ')}; use at least 32 random bytes (openssl rand -base64 32).`,
        );
      return pass('Secrets in .dev.vars are at least 32 characters long.');
    },
  },
  {
    id: 'security.dev-vars-ignored',
    title: '.dev.vars is git-ignored',
    category: 'security',
    platforms: ['cloudflare'],
    severity: 'error',
    run(ctx) {
      const dv = ctx.project.devVars;
      if (!dv.file) return pass('No .dev.vars file.');
      if (!dv.gitignored)
        return fail('.dev.vars exists but is not listed in .gitignore; local secrets would be committed.');
      return pass('.dev.vars is ignored.');
    },
  },
  {
    id: 'security.headers-enabled',
    title: 'Security headers preset',
    category: 'security',
    severity: 'warn',
    run(ctx) {
      const h = ctx.config.resolved.security.headers;
      if (!h)
        return warn(
          'security.headers is disabled; HSTS, Permissions-Policy, COOP and friends are not emitted (securityheaders.com grade drops to F).',
        );
      const off: string[] = [];
      if (!h.hsts) off.push('hsts');
      if (!h.permissionsPolicy) off.push('permissionsPolicy');
      if (!h.frameOptions) off.push('frameOptions');
      if (!h.referrerPolicy) off.push('referrerPolicy');
      if (!h.noSniff) off.push('noSniff');
      if (off.length)
        return warn(`Headers preset active but ${off.join(', ')} switched off; the A+ grade needs them.`);
      return pass(`A+ preset${h.hsts?.preload ? ' with HSTS preload' : ''}.`);
    },
  },
  {
    id: 'security.csp-enabled',
    title: 'Content Security Policy',
    category: 'security',
    severity: 'warn',
    run(ctx) {
      const csp = ctx.config.resolved.security.csp;
      if (!csp || csp.mode === 'off')
        return warn(
          'CSP is off; enable `security.csp` (auto mode: hashes for static routes, nonces elsewhere).',
        );
      const notes: string[] = [];
      if (!csp.strictDynamic) notes.push('strict-dynamic disabled');
      if (csp.trustedTypes) notes.push('Trusted Types enforced');
      return pass(`mode ${csp.mode}${notes.length ? ` (${notes.join(', ')})` : ''}.`);
    },
  },
  {
    id: 'security.csp-report-only',
    title: 'CSP report-only',
    category: 'security',
    severity: 'info',
    run(ctx) {
      const csp = ctx.config.resolved.security.csp;
      if (!csp || csp.mode === 'off') return skip('CSP is off.');
      if (csp.reportOnly === true)
        return info(
          'CSP is report-only: violations are collected but nothing is blocked. Run `hypdriv csp suggest` on the reports, then switch `reportOnly` off.',
        );
      if (csp.reportOnly === 'both') return pass('Enforced policy plus a stricter report-only policy.');
      return pass('CSP is enforced.');
    },
  },
  {
    id: 'security.shield',
    title: 'Shield and bot policies',
    category: 'security',
    severity: 'warn',
    run(ctx) {
      const s = ctx.config.resolved.security;
      if (!s.shield)
        return warn(
          'security.shield is disabled; method allow-list, traversal and body-size protections are off.',
        );
      if (!s.bots) return info('security.bots is disabled; no bot classification or honeypots.');
      return pass(
        `shield on · bots: verified=${s.bots.verified}, likely=${s.bots.likelyAutomated}, definite=${s.bots.definitelyAutomated}.`,
      );
    },
  },
  {
    id: 'security.hsts-origin',
    title: 'HSTS preload readiness',
    category: 'security',
    severity: 'info',
    run(ctx) {
      const h = ctx.config.resolved.security.headers;
      if (!h?.hsts) return skip('HSTS is off.');
      if (h.hsts.preload) {
        if (!h.hsts.includeSubDomains || h.hsts.maxAge < 31536000)
          return warn('HSTS preload requires includeSubDomains and max-age >= 31536000.');
        return pass('HSTS preload-ready; submit the domain at hstspreload.org.');
      }
      return pass(
        `HSTS max-age ${h.hsts.maxAge}${h.hsts.includeSubDomains ? ', includeSubDomains' : ''} (add preload: true once every subdomain is https).`,
      );
    },
  },
];
