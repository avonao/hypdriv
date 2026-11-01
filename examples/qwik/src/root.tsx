import { component$ } from '@qwik.dev/core';
import { DocumentHeadTags, RouterOutlet, useQwikRouter } from '@qwik.dev/router';
import './global.css';

export default component$(() => {
  useQwikRouter();

  return (
    <>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <DocumentHeadTags />
      </head>
      <body>
        <RouterOutlet />
      </body>
    </>
  );
});
