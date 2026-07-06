import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { PracticeStore } from './practice.store';

@Injectable({ providedIn: 'root' })
export class ReviewRetryNavigationService {
  private readonly practice = inject(PracticeStore);
  private readonly router = inject(Router);

  async start(attemptIds: readonly string[]): Promise<boolean> {
    const started = await this.practice.createReviewRetrySession(attemptIds);
    if (started) {
      await this.router.navigateByUrl('/random-quiz');
    }
    return started;
  }
}
