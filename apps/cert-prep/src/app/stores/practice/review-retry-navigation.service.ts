import { inject, Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { from, Observable, of, switchMap } from 'rxjs';
import { PracticeStore } from './practice.store';

@Injectable({ providedIn: 'root' })
export class ReviewRetryNavigationService {
  private readonly practice = inject(PracticeStore);
  private readonly router = inject(Router);

  start(attemptIds: readonly string[]): Observable<boolean> {
    return this.practice.createReviewRetrySession(attemptIds).pipe(
      switchMap((started) =>
        started ? from(this.router.navigateByUrl('/random-quiz')).pipe(switchMap(() => of(true))) : of(false),
      ),
    );
  }
}
