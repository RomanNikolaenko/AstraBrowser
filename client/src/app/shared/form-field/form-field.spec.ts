import { FormField, emailFormat, matches, minLength, normalizeUrl, required, urlFormat, validateFields } from './form-field';

describe('FormField', () => {
  it('should return the first failing validator message', () => {
    const field = new FormField([required('Обов’язкове'), emailFormat('Некоректна пошта')]);

    expect(field.error()).toBe('Обов’язкове');
    field.value.set('not-an-email');
    expect(field.error()).toBe('Некоректна пошта');
    field.value.set('user@example.com');
    expect(field.error()).toBeNull();
  });

  it('should treat whitespace as an empty value', () => {
    const field = new FormField([required('Обов’язкове')]);

    field.value.set('   ');
    expect(field.error()).toBe('Обов’язкове');
  });

  it('should check the minimum length', () => {
    const field = new FormField([minLength(8, 'Закороткий')]);

    field.value.set('1234567');
    expect(field.error()).toBe('Закороткий');
    field.value.set('12345678');
    expect(field.error()).toBeNull();
  });

  it('should compare with another field and react to its changes', () => {
    const password = new FormField([]);
    const confirmation = new FormField([matches(() => password.value(), 'Не збігаються')]);

    password.value.set('secret-1');
    confirmation.value.set('secret-1');
    expect(confirmation.error()).toBeNull();

    password.value.set('secret-2');
    expect(confirmation.error()).toBe('Не збігаються');
  });

  it('should hide the error until the field is touched', () => {
    const field = new FormField([required('Обов’язкове')]);

    expect(field.visibleError()).toBeNull();
    field.touched.set(true);
    expect(field.visibleError()).toBe('Обов’язкове');
  });

  it('should touch every field and report validity', () => {
    const login = new FormField([required('Обов’язкове')]);
    const password = new FormField([required('Обов’язкове')]);
    password.value.set('secret');

    expect(validateFields([login, password])).toBe(false);
    expect(login.touched()).toBe(true);
    expect(password.touched()).toBe(true);

    login.value.set('user');
    expect(validateFields([login, password])).toBe(true);
  });
});

describe('normalizeUrl', () => {
  it('should accept site addresses with or without a scheme', () => {
    expect(normalizeUrl('angular.dev')).toBe('https://angular.dev/');
    expect(normalizeUrl(' http://example.com/path ')).toBe('http://example.com/path');
  });

  it('should reject non-web and malformed addresses', () => {
    expect(normalizeUrl('localhost')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });

  it('should validate through urlFormat', () => {
    const field = new FormField([urlFormat('Некоректна адреса')]);
    field.value.set('example');
    expect(field.error()).toBe('Некоректна адреса');
    field.value.set('example.com');
    expect(field.error()).toBeNull();
  });
});
