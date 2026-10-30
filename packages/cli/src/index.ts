/**
 * `@hypdriv/cli` — the `hypdriv` command. Programmatic use:
 *
 * ```ts
 * import { main, runCommand, createMemoryIO } from '@hypdriv/cli';
 * const io = createMemoryIO({ cwd: '/path/to/app' });
 * const code = await runCommand('doctor', ['--json'], io);
 * const report = JSON.parse(io.out);
 * ```
 */

export { parseMetafile, summarizeMetafile } from './analyze/metafile';
export {
  attributeBytes,
  decodeMappings,
  decodeVlq,
  encodeVlq,
  parseSourceMap,
  type SourceMapV3,
} from './analyze/sourcemap';
export { analyzeVercelOutput, type VercelAnalysis, type VercelFunctionReport } from './analyze/vercel';
export {
  type AnalyzeSnapshot,
  countTopLevelAwaits,
  parseWranglerSizes,
  type WorkerAnalysis,
} from './analyze/weights';
export {
  type CommandInfo,
  GLOBAL_OPTIONS,
  type OptionSpec,
  type ParsedArgs,
  parseCommandArgs,
  UsageError,
} from './args';
export { auditCache, type CacheAuditResult } from './audit/cache';
export { auditCsp, type CspAuditResult } from './audit/csp';
export { gradeHeaders, type HeaderGrade } from './audit/headers';
export { type Command, commands, findCommand } from './commands/index';
export { CliError } from './context';
export { allChecks } from './doctor/registry';
export { type DoctorRun, runDoctor } from './doctor/run';
export type {
  Check,
  CheckCategory,
  CheckContext,
  CheckReport,
  CheckResult,
  CheckStatus,
} from './doctor/types';
export { applyInitPlan, buildInitPlan, type InitPlan, type PlanItem } from './init/plan';
export { createMemoryIO, createNodeIO, type ExecResult, type IO, type MemoryIO } from './io';
export { main, runCommand } from './main';
export { type DeployPlatform, detectPlatform, detectProject, type ProjectInfo } from './project';
export { classifyUpdate, compareVersions, parseVersion, rangeBase, type UpdateDiff } from './semver';
export { cliVersion } from './version';
