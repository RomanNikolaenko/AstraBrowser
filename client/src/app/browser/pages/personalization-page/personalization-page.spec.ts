import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../../../shared/settings/settings';
import { PersonalizationPage } from './personalization-page';

describe('PersonalizationPage', () => {
  const setup = async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [PersonalizationPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(PersonalizationPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const click = async (selector: string) => {
      element.querySelector<HTMLElement>(selector)?.click();
      await fixture.whenStable();
    };
    return { fixture, element, click, settings: TestBed.inject(SettingsStore) };
  };

  afterEach(() => {
    delete document.documentElement.dataset['accent'];
    delete document.documentElement.dataset['theme'];
  });

  it('should change the theme and the accent color', async () => {
    const { click, settings } = await setup();
    expect(document.documentElement.dataset['accent']).toBeUndefined();

    await click('input[aria-label="Фіолетовий"]');
    expect(settings.accent()).toBe('violet');
    expect(document.documentElement.dataset['accent']).toBe('violet');

    await click('input[name="personalization-theme"][value="dark"]');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });

  it('should pick a new tab background and offer an own image only once it is chosen', async () => {
    const { fixture, element, click, settings } = await setup();
    const labels = [...element.querySelectorAll('.background__label')].map((label) => label.textContent?.trim());
    expect(labels).toEqual(['Бульбашки', 'Північне сяйво', 'Захід сонця', 'Океан', 'Без фону', 'Своє зображення']);
    expect(element.querySelector<HTMLInputElement>('input[name="new-tab-background"][value="custom"]')?.disabled).toBe(true);

    await click('input[name="new-tab-background"][value="aurora"]');
    expect(settings.newTabBackground()).toBe('aurora');

    settings.newTabImage.set('data:image/jpeg;base64,AAAA');
    settings.newTabBackground.set('custom');
    await fixture.whenStable();
    await click('button.page__button');
    expect([...element.querySelectorAll('button.page__button')].map((button) => button.textContent?.trim())).toEqual([
      'Вибрати…',
    ]);
    expect(settings.newTabImage()).toBe('');
    expect(settings.newTabBackground()).toBe('bubbles');
  });
});
