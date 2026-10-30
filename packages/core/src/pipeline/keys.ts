import { type StateKey, stateKey } from './context';

/**
 * Cross-package state slots: set by one package's stage, read by another's without a runtime dependency
 * between them. Package-private slots stay in their packages.
 */

/**
 * `true` when the flags stage will add its bucketing cookie (`hyp_uid`) in its `post`. Platform cache
 * stages (Vercel CDN) read it to avoid storing a response that sets a per-visitor cookie.
 */
export const FLAGS_COOKIE_PENDING_KEY: StateKey<boolean> = stateKey<boolean>('flags.needsCookie');
