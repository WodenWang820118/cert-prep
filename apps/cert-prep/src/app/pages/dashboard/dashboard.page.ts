import { Component } from '@angular/core';
import { WrongAnswerDashboardComponent } from '../../components/wrong-answer-dashboard/wrong-answer-dashboard.component';

@Component({
  selector: 'app-dashboard-page',
  imports: [WrongAnswerDashboardComponent],
  templateUrl: './dashboard.page.html',
  styleUrl: './dashboard.page.css',
})
export class DashboardPage {}
