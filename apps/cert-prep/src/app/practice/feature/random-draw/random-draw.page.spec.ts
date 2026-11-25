import { TestBed } from '@angular/core/testing';
import { CERT_PREP_API } from '../../../core/data';
import { RandomDrawPage } from './random-draw.page';

describe('RandomDrawPage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [RandomDrawPage],
      providers: [{ provide: CERT_PREP_API, useValue: {} }],
    });
  });

  it('renders the random draw practice page', () => {
    const fixture = TestBed.createComponent(RandomDrawPage);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Random draw');
    expect(fixture.nativeElement.textContent).toContain(
      'Select a project before starting practice.',
    );
  });
});
