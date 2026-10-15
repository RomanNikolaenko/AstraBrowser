import {
  FormField,
  emailFormat,
  matches,
  minLength,
  normalizeAddress,
  normalizeUrl,
  required,
  urlFormat,
  validateFields,
} from './form-field';

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

  it('should open local development servers over http', () => {
    expect(normalizeUrl('localhost')).toBe('http://localhost/');
    expect(normalizeUrl('localhost:4200/home')).toBe('http://localhost:4200/home');
    expect(normalizeUrl('app.localhost:3000')).toBe('http://app.localhost:3000/');
    expect(normalizeUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalizeUrl('192.168.1.10')).toBe('http://192.168.1.10/');
    expect(normalizeUrl('[::1]:5173')).toBe('http://[::1]:5173/');
    expect(normalizeUrl('http://intranet:8080/')).toBe('http://intranet:8080/');
    expect(normalizeUrl('https://localhost:4433')).toBe('https://localhost:4433/');
    expect(normalizeUrl('devbox:8080')).toBe('https://devbox:8080/');
  });

  it('should open the source of a page typed with view-source:', () => {
    expect(normalizeAddress('view-source:example.com')).toBe('view-source:https://example.com/');
    expect(normalizeAddress(' VIEW-SOURCE:http://localhost:4200/')).toBe('view-source:http://localhost:4200/');
    expect(normalizeAddress('view-source:javascript:alert(1)')).toBeNull();
    expect(normalizeAddress('angular.dev')).toBe('https://angular.dev/');
    expect(normalizeAddress('рецепт борщу')).toBeNull();
    // Файл комп'ютера — адресою file:, а у формах закладок (normalizeUrl) — ні.
    expect(normalizeAddress('file:///C:/Users/me/page.html')).toBe('file:///C:/Users/me/page.html');
    expect(normalizeAddress(' C:\\Users\\me\\Мої документи\\звіт.pdf ')).toBe(
      'file:///C:/Users/me/%D0%9C%D0%BE%D1%97%20%D0%B4%D0%BE%D0%BA%D1%83%D0%BC%D0%B5%D0%BD%D1%82%D0%B8/%D0%B7%D0%B2%D1%96%D1%82.pdf'
    );
    expect(normalizeUrl('file:///C:/Users/me/page.html')).toBeNull();
  });

  it('should reject non-web and malformed addresses', () => {
    expect(normalizeUrl('intranet')).toBeNull();
    expect(normalizeUrl('localhost 4200')).toBeNull();
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
