import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../../core/data';
import { WholeSourcePage } from './whole-source.page';

describe('WholeSourcePage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [WholeSourcePage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the whole source practice page', () => {
    const fixture = TestBed.createComponent(WholeSourcePage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Whole source');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });
});
