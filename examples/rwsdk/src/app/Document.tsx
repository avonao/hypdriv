import type { DocumentProps } from 'rwsdk/router';
import styles from './styles.css?url';

// RedwoodSDK renders the Document around every page. The <script> tag below is the client entry; RedwoodSDK gives
// it the request's nonce (requestInfo.rw.nonce), which hypdrivMiddleware() set to the nonce of Hypdriv's CSP.
export const Document = ({ children }: DocumentProps) => (
  <html lang="en">
    <head>
      <meta charSet="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Hypdriv on RedwoodSDK</title>
      <link rel="stylesheet" href={styles} />
      <link rel="modulepreload" href="/src/client.tsx" />
    </head>
    <body>
      <nav>
        <a href="/">Home</a> · <a href="/about">About</a> · <a href="/products/42">Product 42</a> ·{' '}
        <a href="/api/ping">API</a>
      </nav>
      <div id="root">{children}</div>
      <script>import("/src/client.tsx")</script>
    </body>
  </html>
);
