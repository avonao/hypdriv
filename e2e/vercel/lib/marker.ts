/**
 * One structured line in the function logs that the suite finds through Vercel's runtime-logs stream
 * (`GET /v1/projects/{project}/deployments/{deployment}/runtime-logs`): Vercel has no writable store on a
 * plain project, so job outcomes are reported as log markers instead of KV records.
 */
export function marker(kind: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ e2e: kind, ...fields, at: new Date().toISOString() }));
}
