import { useNuxtApp, useState } from 'nuxt/app';
import type { Ref } from 'vue';
import { FACTS_KEY, type HypEventContext, type HypFacts } from './facts';

function eventFacts(): HypEventContext | undefined {
  if (!import.meta.server) return undefined;
  return useNuxtApp().ssrContext?.event?.context?.[FACTS_KEY] as HypEventContext | undefined;
}

/**
 * HypDriv's facts about the current request — request id, runner, matched route, country, locale, CSP mode and
 * the public feature flags — rendered on the server and hydrated from Nuxt's payload on the client. `null` when
 * HypDriv did not handle the request (prerendering, or the module's `dev: false` in development).
 *
 * ```vue
 * <script setup lang="ts">
 * const hyp = useHyp();
 * </script>
 * <template><p v-if="hyp?.flags.newHero">New hero</p></template>
 * ```
 */
export function useHyp(): Ref<HypFacts | null> {
  return useState<HypFacts | null>('hypdriv:facts', () => {
    const facts = eventFacts();
    if (!facts) return null;
    const { nonce: _nonce, ...rest } = facts;
    return rest;
  });
}

/**
 * The request's CSP nonce during server rendering (for markup Nuxt does not render through unhead, such as a
 * third-party snippet in `v-html`); `undefined` on the client and when the render is cached by Nitro. Never put it
 * into the payload: the browser hides nonce attributes from scripts for a reason.
 */
export function useHypNonce(): string | undefined {
  return eventFacts()?.nonce;
}
