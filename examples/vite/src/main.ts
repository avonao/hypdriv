import './style.css';

const pages: Record<string, string> = {
  '/': '<h1>Hypdriv × Vite</h1><p>A single-page app behind the Hypdriv pipeline.</p>',
  '/about': '<h1>About</h1><p>Client-side route served by the SPA fallback.</p>',
  '/account': '<h1>Account</h1><p>Deep links get the same CSP as the shell.</p>',
};

function render(): void {
  const app = document.querySelector<HTMLElement>('#app');
  if (!app) return;
  app.innerHTML = pages[location.pathname] ?? '<h1>Not found</h1>';
}

document.addEventListener('click', (event) => {
  const link = (event.target as HTMLElement).closest('a');
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();
  history.pushState(null, '', link.pathname);
  render();
});
window.addEventListener('popstate', render);
render();
