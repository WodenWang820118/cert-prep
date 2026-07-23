import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/constants/app-config.constants';
import { App } from './app/components/app/app.component';

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
