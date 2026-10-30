import type { Check, CheckContext, CheckReport, CheckResult, CheckStatus } from './types';

export interface DoctorRunOptions {
  /** Apply safe fixes and re-run the fixed checks. */
  fix?: boolean;
  /** Restrict to these check ids (tests, `--only`). */
  only?: string[];
  /** Per-check timeout (default 30 s). */
  timeoutMs?: number;
}

export interface DoctorSummary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  total: number;
  fixed: number;
}

export interface DoctorRun {
  reports: CheckReport[];
  summary: DoctorSummary;
  /** Exit code: 1 when any check failed. */
  exitCode: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function runOne(check: Check, ctx: CheckContext, timeoutMs: number): Promise<{ result: CheckResult; durationMs: number }> {
  const started = performance.now();
  try {
    const result = await withTimeout(Promise.resolve(check.run(ctx)), timeoutMs, check.id);
    return { result, durationMs: performance.now() - started };
  } catch (err) {
    return {
      result: { status: 'fail', message: `check crashed: ${(err as Error).message}` },
      durationMs: performance.now() - started,
    };
  }
}

function toReport(check: Check, result: CheckResult, durationMs: number): CheckReport {
  return {
    id: check.id,
    title: check.title,
    category: check.category,
    severity: check.severity,
    status: result.status,
    message: result.message,
    ...(result.details?.length ? { details: result.details } : {}),
    ...(result.fix ? { fix: result.fix.description } : {}),
    fixable: Boolean(result.fix?.apply),
    ...(result.informational ? { informational: true } : {}),
    durationMs: Math.round(durationMs * 10) / 10,
  };
}

/** Runs the checks sequentially (they share file-system state) and optionally applies fixes. */
export async function runDoctor(checks: Check[], ctx: CheckContext, options: DoctorRunOptions = {}): Promise<DoctorRun> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const selected = options.only?.length ? checks.filter((c) => options.only!.includes(c.id)) : checks;
  const reports: CheckReport[] = [];
  let fixed = 0;
  for (const check of selected) {
    const { result, durationMs } = await runOne(check, ctx, timeoutMs);
    let report = toReport(check, result, durationMs);
    if (options.fix && result.status !== 'pass' && result.fix?.apply) {
      try {
        await result.fix.apply();
        ctx.refresh?.();
        const rerun = await runOne(check, ctx, timeoutMs);
        report = { ...toReport(check, rerun.result, durationMs + rerun.durationMs), fix: result.fix.description, fixable: true, fixed: rerun.result.status === 'pass' };
        if (report.fixed) fixed++;
      } catch (err) {
        report = { ...report, message: `${report.message} (fix failed: ${(err as Error).message})`, fixed: false };
      }
    }
    reports.push(report);
  }
  const count = (status: CheckStatus) => reports.filter((r) => r.status === status).length;
  const summary: DoctorSummary = { pass: count('pass'), warn: count('warn'), fail: count('fail'), skip: count('skip'), total: reports.length, fixed };
  return { reports, summary, exitCode: summary.fail > 0 ? 1 : 0 };
}
