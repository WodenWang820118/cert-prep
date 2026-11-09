import { displayChoice } from './choice-display';

describe('displayChoice', () => {
  it.each([
    ['ASCII ordinals', ['1 からかって', '2 ためらって'], ['からかって', 'ためらって']],
    ['full-width ordinals', ['１　からかって', '２　ためらって'], ['からかって', 'ためらって']],
    ['dots', ['1. First', '2．Second'], ['First', 'Second']],
    ['parentheses', ['１) First', '２）Second'], ['First', 'Second']],
    ['mixed digit widths', ['1 First', '２ Second'], ['First', 'Second']],
  ])('strips sequential %s for display without changing the choices', (_, choices, expected) => {
    const original = [...choices];
    expect(choices.map((choice) => displayChoice(choices, choice))).toEqual(expected);
    expect(choices).toEqual(original);
  });

  it.each([
    ['mixed numbering', ['1 First', 'Second']],
    ['skipped ordinals', ['1 First', '3 Third']],
    ['reversed ordinals', ['2 Second', '1 First']],
    ['repeated ordinals', ['1 First', '1 Second']],
    ['zero-based ordinals', ['0 First', '1 Second']],
    ['plain choices', ['からかって', 'ためらって']],
    ['digits without separators', ['1からかって', '2ためらって']],
    ['numbers within text', ['There are 1 items', 'There are 2 items']],
  ])('preserves %s', (_, choices) => {
    expect(choices.map((choice) => displayChoice(choices, choice))).toEqual(choices);
  });

  it('handles multi-digit ordinals and preserves numbers in the choice content', () => {
    const choices = Array.from({ length: 12 }, (_, index) => `${index + 1}. ${index + 10} items`);
    expect(displayChoice(choices, choices[9])).toBe('19 items');
    expect(displayChoice(choices, '99. Missing choice')).toBe('99. Missing choice');
    expect(displayChoice([], '1 First')).toBe('1 First');
  });
});
