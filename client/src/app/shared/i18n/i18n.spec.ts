import { TestBed } from '@angular/core/testing';
import { EN } from './en';
import { I18n, TranslatePipe, formatDate, plural, systemLanguage, translate } from './i18n';

describe('systemLanguage', () => {
  it('should be English only for English Windows', () => {
    expect(systemLanguage(['en-US', 'uk'])).toBe('en');
    expect(systemLanguage(['EN-GB'])).toBe('en');
    expect(systemLanguage(['uk-UA', 'en-US'])).toBe('uk');
    expect(systemLanguage(['de-DE'])).toBe('uk');
    expect(systemLanguage([])).toBe('uk');
  });
});

describe('I18n', () => {
  let i18n: I18n;

  beforeEach(() => {
    localStorage.clear();
    i18n = TestBed.inject(I18n);
  });

  it('should follow the system by default and show Ukrainian outside the app', () => {
    expect(i18n.preference()).toBe('system');
    expect(i18n.language()).toBe('uk');
    expect(translate('Нова вкладка')).toBe('Нова вкладка');
  });

  it('should switch to English, remember the choice and set the page language', () => {
    i18n.preference.set('en');
    TestBed.tick();

    expect(translate('Нова вкладка')).toBe('New tab');
    expect(document.documentElement.lang).toBe('en');
    expect(JSON.parse(localStorage.getItem('astra.settings.language') ?? 'null')).toBe('en');

    i18n.preference.set('uk');
    TestBed.tick();

    expect(translate('Нова вкладка')).toBe('Нова вкладка');
    expect(document.documentElement.lang).toBe('uk');
  });

  it('should fill in values and keep the spaces used for joining', () => {
    i18n.preference.set('en');

    expect(translate('Встановити версію {0}', ['0.2.0'])).toBe('Install version 0.2.0');
    expect(translate('«{0}» на {1}', ['anna', 'example.com'])).toBe('“anna” on example.com');
    expect(translate(' Показати пароль для ')).toBe(' Show password for ');
    expect(translate('Ласкаво\n      просимо')).toBe('Welcome');
  });

  it('should leave text without a translation in Ukrainian', () => {
    i18n.preference.set('en');

    expect(translate('Невідомий текст {0}', [1])).toBe('Невідомий текст 1');
  });

  it('should pick plural forms of the current language', () => {
    const files = (count: number) => plural(count, ['{0} файл', '{0} файли', '{0} файлів'], ['{0} file', '{0} files']);

    expect([1, 2, 5, 11, 21, 22, 25].map(files)).toEqual([
      '1 файл',
      '2 файли',
      '5 файлів',
      '11 файлів',
      '21 файл',
      '22 файли',
      '25 файлів',
    ]);

    i18n.preference.set('en');

    expect([0, 1, 2, 21].map(files)).toEqual(['0 files', '1 file', '2 files', '21 files']);
  });

  it('should format dates in the current language', () => {
    const date = new Date(2026, 0, 15);
    const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' };

    expect(formatDate(date, options)).toBe(new Intl.DateTimeFormat('uk-UA', options).format(date));

    i18n.preference.set('en');

    expect(formatDate(date, options)).toBe('January 15');
  });

  it('should translate in templates and show non-text values as they are', () => {
    const pipe = TestBed.runInInjectionContext(() => new TranslatePipe());
    i18n.preference.set('en');

    expect(pipe.transform('Закрити вкладку «{0}»', ['Astra'])).toBe('Close tab “Astra”');
    expect(pipe.transform(3)).toBe('3');
    expect(pipe.transform(null)).toBe('');
  });
});

describe('EN', () => {
  it('should keep the same placeholders as the Ukrainian text', () => {
    const placeholders = (text: string) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join(' ');
    for (const [key, value] of Object.entries(EN)) {
      expect(placeholders(value), key).toBe(placeholders(key));
    }
  });
});
