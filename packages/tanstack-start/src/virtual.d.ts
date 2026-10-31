/// <reference types="@hypdriv/vite/virtual" />

declare module 'virtual:hypdriv/tanstack-start' {
  /**
   * The per-build prerender token (`withHypDriv()` sends it with Start's prerender requests). Empty in development,
   * and removed from the server output once the build's prerendering finished.
   */
  export const prerenderToken: string;
}
