import type { Route } from '@angular/router';
import { BackendRuntimeReadyGuard } from '../guards/runtime-ready.guard';

export const appRoutes: Route[] = [
  { path: '', pathMatch: 'full', redirectTo: 'build' },
  {
    path: 'capture-workbench-trial',
    loadComponent: () =>
      import('../pages/capture-workbench-trial/capture-workbench-trial.page').then(
        (m) => m.CaptureWorkbenchTrialPage,
      ),
    title: 'Capture Workbench - Cert Prep',
  },
  {
    path: 'build',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../pages/build-workbench/build-workbench.page').then(
        (m) => m.BuildWorkbenchPage,
      ),
    title: 'Build - Cert Prep',
  },
  {
    path: 'full-exam',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../pages/full-exam/full-exam.page').then((m) => m.FullExamPage),
    title: 'Full Exam - Cert Prep',
  },
  {
    path: 'random-quiz',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../pages/random-quiz/random-quiz.page').then(
        (m) => m.RandomQuizPage,
      ),
    title: 'Random Quiz - Cert Prep',
  },
  {
    path: 'dashboard',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../pages/dashboard/dashboard.page').then((m) => m.DashboardPage),
    title: 'Dashboard - Cert Prep',
  },
  {
    path: 'runtime',
    loadComponent: () =>
      import('../pages/runtime-manager/runtime-manager.page').then(
        (m) => m.RuntimeManagerPage,
      ),
    title: 'Manage Runtime - Cert Prep',
  },
  {
    path: 'review',
    canActivate: [BackendRuntimeReadyGuard],
    loadComponent: () =>
      import('../pages/wrong-answer-review/wrong-answer-review.page').then(
        (m) => m.WrongAnswerReviewPage,
      ),
    title: 'Review - Cert Prep',
  },
  { path: '**', redirectTo: 'build' },
];
