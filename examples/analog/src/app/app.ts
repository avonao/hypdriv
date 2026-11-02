import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  template: `
    <nav>
      <a routerLink="/">Home</a>
      <a routerLink="/about">About</a>
      <a routerLink="/ssr">Request facts</a>
      <a routerLink="/blog/hello-hypdriv">Blog</a>
      <a href="/api/hello">/api/hello</a>
      <a href="/_hypdriv/health">/_hypdriv/health</a>
    </nav>
    <main><router-outlet /></main>
  `,
  styles: `
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1rem;
      margin-bottom: 2rem;
    }
  `,
})
export class App {}
