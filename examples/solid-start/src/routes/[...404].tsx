import { A } from '@solidjs/router';
import { HttpStatusCode } from '@solidjs/start';

export default function NotFound() {
  return (
    <main>
      <HttpStatusCode code={404} />
      <h1>Not found</h1>
      <p>
        Nothing lives here. <A href="/">Back home</A>
      </p>
    </main>
  );
}
