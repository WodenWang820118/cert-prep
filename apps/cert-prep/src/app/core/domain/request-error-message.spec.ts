import { requestErrorMessage } from './request-error-message';

describe('requestErrorMessage', () => {
  it('prefers the response body message', () => {
    expect(
      requestErrorMessage({ error: { message: 'body' }, message: 'top' }, 'fb'),
    ).toBe('body');
  });

  it('uses a non-empty string body next', () => {
    expect(requestErrorMessage({ error: 'text', message: 'top' }, 'fb')).toBe(
      'text',
    );
  });

  it('uses the error message when the body has none', () => {
    expect(requestErrorMessage({ error: '', message: 'top' }, 'fb')).toBe(
      'top',
    );
  });

  it('falls back when nothing usable is present', () => {
    expect(requestErrorMessage({ error: {}, message: '' }, 'fb')).toBe('fb');
    expect(requestErrorMessage({}, 'fb')).toBe('fb');
  });
});
