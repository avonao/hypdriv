import { type ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
// Server config only: this entry imports the Hypdriv runtime. It stamps the request's CSP nonce on what Angular
// renders and exposes the request context to `injectHyp()`.
import { provideHypDriv } from '@hypdriv/analog/angular/server';

import { appConfig } from './app.config';

const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(), provideHypDriv()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
