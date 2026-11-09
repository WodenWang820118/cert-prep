import type { Route } from '@angular/router';
import { BackendRuntimeReadyGuard } from './runtime-ready.guard';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'build' },
  {
    path: 'capture-workbench-trial',
    loadComponent: () =>
      import('../../capture/feature').then((m) => m.CaptureWorkbenchTrialPage),
    title: 'Capture Workbench - Cert Prep',
  },
  {
    path: 'build',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('./build-workbench.page').then((m) => m.BuildWorkbenchPage),
    title: 'Build - Cert Prep',
  },
  {
    path: 'full-exam',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.FullExamPage,
      ),
    title: 'Full Exam - Cert Prep',
  },
  {
    path: 'random-quiz',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.RandomQuizPage,
      ),
    title: 'Random Quiz - Cert Prep',
  },
  {
    path: 'dashboard',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.DashboardPage,
      ),
    title: 'Dashboard - Cert Prep',
  },
  {
    path: 'runtime',
    loadComponent: () =>
      import('../../pages/runtime-manager/runtime-manager.page').then(
        (m) => m.RuntimeManagerPage,
      ),
    title: 'Manage Runtime - Cert Prep',
  },
  {
    path: 'review',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../../practice/feature').then(
        (m) => m.WrongAnswerReviewPage,
      ),
    title: 'Review - Cert Prep',
  },
  { path: '**', redirectTo: 'build' },
];
