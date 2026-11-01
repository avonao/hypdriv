import type { ReactNode } from 'react';
import { Link } from 'waku';

export default async function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <header>
        <nav>
          <Link to="/">Home</Link> · <Link to="/about">About</Link> · <Link to="/dynamic">Request facts</Link>{' '}
          · <a href="/api/hello">API</a>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}

export const getConfig = async () => ({ render: 'static' }) as const;
