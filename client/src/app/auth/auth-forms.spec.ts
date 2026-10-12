import { PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT } from './auth-forms';

describe('auth forms', () => {
  it('should name the real minimal password length in the hint', () => {
    expect(PASSWORD_TOO_SHORT).toContain(` ${PASSWORD_MIN_LENGTH} `);
  });
});
