import { Component, input } from '@angular/core';

// A dynamic route: `/blog/[slug]` is in the Hypdriv manifest as a dynamic page, rendered per request.
@Component({
  selector: 'app-blog-post',
  template: `
    <h1>Post: {{ slug() }}</h1>
    <p>Rendered per request from the route parameter <code>slug</code>.</p>
  `,
})
export default class BlogPostPage {
  // The file router binds route parameters to component inputs (`withComponentInputBinding`).
  readonly slug = input.required<string>();
}
