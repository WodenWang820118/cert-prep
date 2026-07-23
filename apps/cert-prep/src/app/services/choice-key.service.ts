import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ChoiceKeyService {
  key(index: number): string {
    let value = index + 1;
    let key = '';
    while (value > 0) {
      value -= 1;
      key = String.fromCharCode(65 + (value % 26)) + key;
      value = Math.floor(value / 26);
    }
    return key;
  }
}
