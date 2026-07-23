import { TestBed } from '@angular/core/testing';
import { ChoiceKeyService } from './choice-key.service';

describe('ChoiceKeyService', () => {
  let service: ChoiceKeyService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ChoiceKeyService);
  });

  it('creates spreadsheet-style choice labels', () => {
    expect(service.key(0)).toBe('A');
    expect(service.key(25)).toBe('Z');
    expect(service.key(26)).toBe('AA');
    expect(service.key(51)).toBe('AZ');
  });
});
