import { type Check, fail, info, pass, warn } from '../types';

export const workersCompatChecks: Check[] = [
  {
    id: 'compat.node-apis',
    title: 'Node.js APIs unsupported on workerd',
    category: 'workers-compat',
    severity: 'error',
    run(ctx) {
      const findings = ctx.project.sources.nodeApis.filter((f) => f.api !== 'process.exit');
      if (!findings.length)
        return pass(
          'No child_process, worker_threads, cluster, dgram, vm, fs.watch or native-module imports in application code.',
        );
      const details = findings.map((f) => `${f.file}:${f.line}  ${f.api} — ${f.message}`);
      const errors = findings.filter((f) => f.severity === 'error');
      if (errors.length)
        return fail(`${errors.length} unsupported API usage(s) will fail at run time on Workers.`, {
          details,
        });
      return warn(`${findings.length} API usage(s) behave differently on workerd.`, { details });
    },
  },
  {
    id: 'compat.process-exit',
    title: 'process.exit() calls',
    category: 'workers-compat',
    severity: 'warn',
    run(ctx) {
      const findings = ctx.project.sources.nodeApis.filter((f) => f.api === 'process.exit');
      if (!findings.length) return pass('No process.exit() in application code.');
      return warn(
        `${findings.length} process.exit() call(s); on workerd they do nothing useful and hide the real error.`,
        {
          details: findings.map((f) => `${f.file}:${f.line}  ${f.snippet}`),
        },
      );
    },
  },
  {
    id: 'compat.scan-coverage',
    title: 'Source scan coverage',
    category: 'workers-compat',
    severity: 'info',
    run(ctx) {
      const s = ctx.project.sources;
      if (s.truncated)
        return warn(
          `Scanned ${s.filesScanned} files and stopped at the limit; results for larger trees are partial.`,
        );
      if (s.filesScanned === 0)
        return info('No source files found under app/, pages/, src/, components/, lib/.');
      return pass(`${s.filesScanned} source files scanned.`);
    },
  },
];
