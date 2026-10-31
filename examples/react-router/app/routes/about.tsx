import type { Route } from './+types/about';

export function meta(_: Route.MetaArgs) {
  return [{ title: 'About · Hypdriv × React Router' }];
}

// Runs once, at build time (the page is prerendered): its data ships as `about.data` next to the HTML.
export function loader() {
  return { builtAt: new Date().toISOString() };
}

export default function About({ loaderData }: Route.ComponentProps) {
  return (
    <section>
      <h1>About</h1>
      <p>
        Prerendered at <time dateTime={loaderData.builtAt}>{loaderData.builtAt}</time>. Client navigations
        load its data from the static <code>about.data</code> file.
      </p>
    </section>
  );
}
