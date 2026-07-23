import { Component, ChangeDetectionStrategy } from '@angular/core';
import { WrongAnswerDashboardComponent } from '../../components/wrong-answer-dashboard/wrong-answer-dashboard.component';

@Component({
  selector: 'app-dashboard-page',
  imports: [WrongAnswerDashboardComponent],
  templateUrl: './dashboard.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './dashboard.page.css',
})
export class DashboardPage {}
