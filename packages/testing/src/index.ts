/**
 * `@hypdriv/testing` — fakes for Cloudflare bindings, a pipeline harness and request helpers.
 *
 * Fakes implement the structural `*Like` types from `@hypdriv/core`, so anything written against
 * `KVNamespaceLike`, `CacheLike`, `DurableObjectNamespaceLike`, `QueueLike`, `AnalyticsEngineLike`,
 * `ExecutionContextLike` or `RateLimitBindingLike` runs unchanged in Node tests.
 * Vitest presets live in `@hypdriv/testing/vitest`.
 */

export { createClock, DEFAULT_CLOCK_START, type FakeClock } from './clock';
export * from './fakes';
export {
  collectSetCookies,
  createTestContext,
  currentTestEnv,
  expectHeaders,
  type HeaderExpectation,
  isResolvedConfig,
  type NextHandler,
  parseSetCookie,
  type RunStageResult,
  requestWithCf,
  responseJson,
  responseText,
  runStage,
  runStages,
  TEST_ENV_GLOBAL,
  type TestContextOptions,
  withEnv,
} from './harness';
