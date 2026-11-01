/**
 * A cron schedule as the Worker's scheduled handler compares it (`cache.warm.cron`, `jobs.cron`, `triggers.crons`):
 * trimmed, runs of whitespace collapsed.
 */
export function normalizeCron(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}
