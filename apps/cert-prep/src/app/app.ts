import { CdkTrapFocus } from '@angular/cdk/a11y';
import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  effect,
  inject,
  signal,
} from '@angular/core';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { Subscription } from 'rxjs';
import { RuntimeConsentDialogsComponent } from './components/model-health/runtime-consent-dialogs.component';
import { ProjectRailComponent } from './components/project-rail/project-rail.component';
import type { StudyPageOption } from './contracts/app.contracts';
import { RuntimeManagerPage } from './pages/runtime-manager/runtime-manager.page';
import { OperationStore } from './stores/operation.store';
import { ProjectStore } from './stores/project.store';
import { DesktopRuntimeStore } from './stores/desktop-runtime/desktop-runtime.store';
import { WorkspaceFacade } from './stores/workspace.facade';

const LAST_PROJECT_STORAGE_KEY = 'certPrepLastProjectId';

@Component({
  imports: [
    CdkTrapFocus,
    ProjectRailComponent,
    RuntimeManagerPage,
    RuntimeConsentDialogsComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  @ViewChild('runtimeManagerDialog')
  private runtimeManagerDialog?: ElementRef<HTMLElement>;

  protected readonly title = 'Cert Prep';
  protected readonly studyPages: readonly StudyPageOption[] = [
    { id: 'build', label: 'Build', icon: 'pi pi-wrench', path: '/build' },
    {
      id: 'full_exam',
      label: 'Full Exam',
      icon: 'pi pi-file-check',
      path: '/full-exam',
    },
    {
      id: 'random_quiz',
      label: 'Random Quiz',
      icon: 'pi pi-sync',
      path: '/random-quiz',
    },
    {
      id: 'dashboard',
      label: 'Dashboard',
      icon: 'pi pi-chart-bar',
      path: '/dashboard',
    },
    { id: 'review', label: 'Review', icon: 'pi pi-history', path: '/review' },
  ];
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  protected readonly currentPath = signal('');
  protected readonly runtimeManagerOpen = signal(false);
  protected readonly aboutDialogOpen = signal(false);
  private readonly router = inject(Router);
  private readonly workspace = inject(WorkspaceFacade);
  private readonly startupProjectId = this.readLastProjectId();
  private hasAttemptedInitialStartupLoad = false;
  private hasAppliedStartupProjectSelection = false;
  private loadingStartupState = false;
  private runtimeManagerRestoreFocus: HTMLElement | null = null;
  private runtimeManagerFocusTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeManagerRestoreFocusTimer: ReturnType<typeof setTimeout> | null =
    null;
  private readonly routerEventsSubscription: Subscription;

  constructor() {
    this.currentPath.set(this.urlPath(this.router.url));
    this.routerEventsSubscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.currentPath.set(this.urlPath(event.urlAfterRedirects));
      }
    });

    effect(() => {
      const selectedProjectId = this.projects.selectedProjectId();
      const backendReady = this.desktopRuntime.isBackendReady();
      const backendStateLoaded = this.workspace.hasLoadedBackendState();

      if (
        this.hasAppliedStartupProjectSelection &&
        selectedProjectId !== null
      ) {
        this.writeLastProjectId(selectedProjectId);
      }

      if (
        !this.hasAttemptedInitialStartupLoad ||
        !backendReady ||
        backendStateLoaded ||
        this.loadingStartupState
      ) {
        return;
      }

      queueMicrotask(() => {
        void this.loadStartupState();
      });
    });
  }

  ngOnInit(): void {
    void this.loadStartupState()
      .finally(() => {
        this.hasAttemptedInitialStartupLoad = true;
      })
      .catch((error: unknown) => {
        queueMicrotask(() => {
          throw error;
        });
      });
  }

  ngOnDestroy(): void {
    this.routerEventsSubscription.unsubscribe();
    this.clearRuntimeManagerFocusTimer();
    this.clearRuntimeManagerRestoreFocusTimer();
  }

  private async loadStartupState(): Promise<void> {
    if (this.loadingStartupState) {
      return;
    }

    this.loadingStartupState = true;
    try {
      await this.workspace.loadStartupState();
      await this.applyStartupProjectSelection();
    } finally {
      this.loadingStartupState = false;
    }
  }

  private async applyStartupProjectSelection(): Promise<void> {
    if (!this.workspace.hasLoadedBackendState()) {
      return;
    }

    const projects = this.projects.projects();
    if (projects.length === 0) {
      this.hasAppliedStartupProjectSelection = true;
      return;
    }

    const targetProjectId =
      this.startupProjectId !== null &&
      projects.some((project) => project.id === this.startupProjectId)
        ? this.startupProjectId
        : projects[0].id;

    if (this.projects.selectedProjectId() !== targetProjectId) {
      await this.workspace.selectProject(targetProjectId);
    }

    this.writeLastProjectId(targetProjectId);
    this.hasAppliedStartupProjectSelection = true;
  }

  private readLastProjectId(): string | null {
    const value = this.projectStorage()
      ?.getItem(LAST_PROJECT_STORAGE_KEY)
      ?.trim();
    return value === undefined || value.length === 0 ? null : value;
  }

  private writeLastProjectId(projectId: string): void {
    try {
      this.projectStorage()?.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
    } catch (error) {
      console.warn('Unable to persist the last selected project.', error);
      // Storage persistence is a convenience; startup should continue without it.
    }
  }

  private projectStorage(): Storage | null {
    const windowRef = globalThis as typeof globalThis & { window?: Window };
    if (typeof windowRef.window === 'undefined') {
      return null;
    }

    try {
      return windowRef.window.localStorage;
    } catch {
      return null;
    }
  }

  protected isRuntimeRoute(): boolean {
    return this.currentPath() === '/runtime';
  }

  protected openRuntimeManager(): void {
    this.clearRuntimeManagerRestoreFocusTimer();
    this.runtimeManagerRestoreFocus = this.activeElement();
    this.runtimeManagerOpen.set(true);
    this.runtimeManagerFocusTimer = setTimeout(() => {
      this.runtimeManagerFocusTimer = null;
      this.focusRuntimeManagerDialog();
    });
  }

  protected openAboutDialog(): void {
    this.aboutDialogOpen.set(true);
  }

  protected closeAboutDialog(): void {
    this.aboutDialogOpen.set(false);
  }

  protected closeRuntimeManager(): void {
    if (!this.runtimeManagerOpen()) {
      return;
    }

    this.clearRuntimeManagerFocusTimer();
    this.runtimeManagerOpen.set(false);
    const restoreFocus = this.runtimeManagerRestoreFocus;
    this.runtimeManagerRestoreFocus = null;
    if (restoreFocus?.isConnected) {
      this.runtimeManagerRestoreFocusTimer = setTimeout(() => {
        this.runtimeManagerRestoreFocusTimer = null;
        restoreFocus.focus();
      });
    }
  }

  private urlPath(url: string): string {
    return url.split(/[?#]/, 1)[0];
  }

  private focusRuntimeManagerDialog(): void {
    const dialog = this.runtimeManagerDialog?.nativeElement;
    if (!this.runtimeManagerOpen() || dialog === undefined) {
      return;
    }

    (
      dialog.querySelector<HTMLElement>(
        'button[aria-label="Close runtime manager"], button:not([disabled])',
      ) ?? dialog
    ).focus();
  }

  private clearRuntimeManagerFocusTimer(): void {
    if (this.runtimeManagerFocusTimer !== null) {
      clearTimeout(this.runtimeManagerFocusTimer);
      this.runtimeManagerFocusTimer = null;
    }
  }

  private clearRuntimeManagerRestoreFocusTimer(): void {
    if (this.runtimeManagerRestoreFocusTimer !== null) {
      clearTimeout(this.runtimeManagerRestoreFocusTimer);
      this.runtimeManagerRestoreFocusTimer = null;
    }
  }

  private activeElement(): HTMLElement | null {
    return document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  }
}
