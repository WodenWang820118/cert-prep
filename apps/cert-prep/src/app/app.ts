import { Component, effect, inject, OnInit } from '@angular/core';
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { Message } from 'primeng/message';
import { ModelHealthComponent } from './components/model-health/model-health.component';
import { RuntimeConsentDialogsComponent } from './components/model-health/runtime-consent-dialogs.component';
import { ProjectRailComponent } from './components/project-rail/project-rail.component';
import type { StudyPageOption } from './contracts/app.contracts';
import { OperationStore } from './stores/operation.store';
import { ProjectStore } from './stores/project.store';
import { DesktopRuntimeStore } from './stores/desktop-runtime/desktop-runtime.store';
import { WorkspaceFacade } from './stores/workspace.facade';

const LAST_PROJECT_STORAGE_KEY = 'certPrepLastProjectId';

@Component({
  imports: [
    Message,
    ModelHealthComponent,
    ProjectRailComponent,
    RuntimeConsentDialogsComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
  ],
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit {
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
      id: 'runtime',
      label: 'Runtime',
      icon: 'pi pi-sliders-h',
      path: '/runtime',
    },
    { id: 'review', label: 'Review', icon: 'pi pi-history', path: '/review' },
  ];
  protected readonly desktopRuntime = inject(DesktopRuntimeStore);
  protected readonly operations = inject(OperationStore);
  protected readonly projects = inject(ProjectStore);
  private readonly router = inject(Router);
  private readonly workspace = inject(WorkspaceFacade);
  private readonly startupProjectId = this.readLastProjectId();
  private hasAttemptedInitialStartupLoad = false;
  private hasAppliedStartupProjectSelection = false;
  private loadingStartupState = false;

  constructor() {
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
    } catch {
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
    const path = this.router.url.split(/[?#]/, 1)[0];
    return path === '/runtime';
  }
}
