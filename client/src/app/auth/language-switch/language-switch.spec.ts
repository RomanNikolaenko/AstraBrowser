import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { I18n } from '../../shared/i18n/i18n';
import { LanguageSwitch } from './language-switch';

describe('LanguageSwitch', () => {
  let fixture: ComponentFixture<LanguageSwitch>;
  let element: HTMLElement;

  const options = () =>
    [...element.querySelectorAll<HTMLInputElement>('.language-switch__input')].map((input) => ({
      name: input.getAttribute('aria-label'),
      code: input.parentElement?.textContent?.trim(),
      checked: input.checked,
    }));

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LanguageSwitch],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(LanguageSwitch);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach(() => localStorage.clear());

  it('should show both languages with the current one selected', () => {
    expect(element.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Мова інтерфейсу');
    expect(options()).toEqual([
      { name: 'Українська', code: 'УКР', checked: true },
      { name: 'English', code: 'ENG', checked: false },
    ]);
  });

  it('should switch the interface to the chosen language', async () => {
    const i18n = TestBed.inject(I18n);

    element.querySelectorAll<HTMLInputElement>('.language-switch__input')[1].click();
    await fixture.whenStable();

    expect(i18n.preference()).toBe('en');
    expect(element.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Interface language');
    expect(options().map((option) => option.checked)).toEqual([false, true]);

    element.querySelectorAll<HTMLInputElement>('.language-switch__input')[0].click();
    await fixture.whenStable();

    expect(i18n.preference()).toBe('uk');
    expect(options().map((option) => option.checked)).toEqual([true, false]);
  });
});
