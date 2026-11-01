// @refresh reload
import { mount, StartClient } from '@solidjs/start/client';

// SolidStart renders the #app root in entry-server.tsx.
mount(() => <StartClient />, document.getElementById('app') as HTMLElement);
