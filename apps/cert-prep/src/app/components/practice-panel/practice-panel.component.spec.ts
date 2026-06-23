import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../cert-prep-api';
import { PracticePanelComponent } from './practice-panel.component';

describe('PracticePanelComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PracticePanelComponent],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    }).compileComponents();
  });

  it('renders the random quiz empty state', () => {
    const fixture = TestBed.createComponent(PracticePanelComponent);
    fixture.componentRef.setInput('sessionMode', 'random_draw');

    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random Quiz');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });
});
