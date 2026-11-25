import { Component, ChangeDetectionStrategy } from '@angular/core';
import { PracticePanelComponent } from '../practice-panel/practice-panel.component';

@Component({
  selector: 'app-random-draw-page',
  imports: [PracticePanelComponent],
  templateUrl: './random-draw.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './random-draw.page.css',
})
export class RandomDrawPage {}
