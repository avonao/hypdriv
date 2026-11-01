import { A, Router } from '@solidjs/router';
import { FileRoutes } from '@solidjs/start/router';
import { Suspense } from 'solid-js';
import './app.css';

export default function App() {
  return (
    <Router
      root={(props) => (
        <>
          <nav>
            <A href="/">Home</A>
            <A href="/about">About</A>
            <A href="/request">Request</A>
            <A href="/posts/hello-world">Post</A>
          </nav>
          <Suspense>{props.children}</Suspense>
        </>
      )}
    >
      <FileRoutes />
    </Router>
  );
}
