import type { Route } from '@angular/router';
import { BackendRuntimeReadyGuard } from './runtime-ready.guard';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'build' },
  {
    path: 'capture',
    loadComponent: () =>
      import('../../capture/feature').then((m) => m.CaptureWorkbenchPage),
    title: 'Capture Workbench - Cert Prep',
  },
  {
    path: 'build',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('./build.page').then((m) => m.BuildPage),
    title: 'Build - Cert Prep',
  },
  {
    path: 'whole-source',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.WholeSourcePage,
      ),
    title: 'Whole source - Cert Prep',
  },
  {
    path: 'random-draw',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.RandomDrawPage,
      ),
    title: 'Random draw - Cert Prep',
  },
  {
    path: 'wrong-answers/summary',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.WrongAnswerSummaryPage,
      ),
    title: 'Wrong-answer summary - Cert Prep',
  },
  {
    path: 'runtime',
    loadComponent: () =>
      import('../../runtime/feature').then(
        (m) => m.RuntimeManagerPage,
      ),
    title: 'Manage Runtime - Cert Prep',
  },
  {
    path: 'wrong-answer-retry',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.WrongAnswerRetryPage,
      ),
    title: 'Wrong-answer retry - Cert Prep',
  },
  { path: '**', redirectTo: 'build' },
];
