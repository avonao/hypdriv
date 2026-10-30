import type { ResolvedConfig } from './resolved';

type QueueConsumer = ResolvedConfig['jobs']['queues'][string];

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * The consumer of a delivered queue batch: the job whose key equals the Cloudflare queue name, else the
 * first job whose `queues` list matches it (exact names before `*` patterns). `null` when none does.
 */
export function queueConsumerFor(
  config: Pick<ResolvedConfig, 'jobs'>,
  queueName: string,
): { name: string; consumer: QueueConsumer } | null {
  const queues = config.jobs.queues;
  const direct = queues[queueName];
  if (direct) return { name: queueName, consumer: direct };
  const entries = Object.entries(queues);
  for (const [name, consumer] of entries)
    if (consumer.queues.some((q) => !q.includes('*') && q === queueName)) return { name, consumer };
  for (const [name, consumer] of entries)
    if (consumer.queues.some((q) => q.includes('*') && wildcard(q).test(queueName)))
      return { name, consumer };
  return null;
}
