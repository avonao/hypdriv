import { hyp } from '@hypdriv/sveltekit/server';
import { fail } from '@sveltejs/kit';

export const actions = {
  default: async ({ request }: { request: Request }) => {
    const form = await request.formData();
    const name = String(form.get('name') ?? '').trim();
    if (!name) return fail(400, { error: 'Name is required' });
    return { greeting: `Hello, ${name}`, requestId: hyp()?.requestId ?? null };
  },
};
