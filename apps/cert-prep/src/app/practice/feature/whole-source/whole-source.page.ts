import { Component, ChangeDetectionStrategy } from '@angular/core';
import { PracticePanelComponent } from '../practice-panel/practice-panel.component';

@Component({
  selector: 'app-whole-source-page',
  imports: [PracticePanelComponent],
  templateUrl: './whole-source.page.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './whole-source.page.css',
})
export class WholeSourcePage {}
