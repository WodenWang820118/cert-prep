import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/core/shell';
import { App } from './app/core/shell';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
