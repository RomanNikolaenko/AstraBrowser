import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, ErrorHandler, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { AppErrorHandler } from './shared/logging/app-error-handler';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Помилки інтерфейсу — ще й у журнал застосунку («Відкрити журнал» у довідці).
    { provide: ErrorHandler, useClass: AppErrorHandler },
    provideRouter(routes),
    provideHttpClient(withFetch()),
  ],
};
