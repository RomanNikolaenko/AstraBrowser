import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../../../shared/settings/settings';
import { SettingsPage } from './settings-page';

describe('SettingsPage', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(SettingsPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const click = async (node: HTMLElement | null | undefined) => {
      node?.click();
      await fixture.whenStable();
    };
    const meta = () => [...element.querySelectorAll('.settings__row .page__meta')].map((node) => node.textContent?.trim());
    return { fixture, element, click, meta };
  };

  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
  });

  it('should switch the theme on the whole document', async () => {
    const { element, click } = await setup();
    const radio = (value: string) => element.querySelector<HTMLInputElement>(`input[name="theme"][value="${value}"]`);
    expect(radio('system')?.checked).toBe(true);

    await click(radio('dark'));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(JSON.parse(localStorage.getItem('astra.settings.theme') ?? 'null')).toBe('dark');

    await click(radio('system'));
    expect(document.documentElement.dataset['theme']).toBeUndefined();
  });

  it('should toggle the bookmarks bar', async () => {
    const { element, click } = await setup();
    const toggle = element.querySelector<HTMLInputElement>('#settings-bookmarks-bar');
    expect(toggle?.checked).toBe(true);

    await click(toggle);

    expect(TestBed.inject(SettingsStore).showBookmarksBar()).toBe(false);
  });

  it('should count records and clear history after confirmation', async () => {
    const now = Date.now();
    localStorage.setItem('astra.history', JSON.stringify([1, 2, 3].map((id) => ({ id: `${id}`, url: 'https://a.example', title: 'A', visitedAt: now }))));
    const { element, click, meta } = await setup();
    expect(meta()).toEqual(['«Як у системі» стежить за темою Windows', 'Показувати закладки під адресним рядком', 'Для запитів з адресного рядка й нової вкладки', '3 записи', 'Порожньо · самі файли лишаються на диску']);

    const clearHistory = element.querySelectorAll<HTMLButtonElement>('.settings__row .page__button')[0];
    await click(clearHistory);
    expect(meta()[3]).toBe('3 записи');

    await click(element.querySelector<HTMLButtonElement>('.page__confirm .page__button--danger'));
    expect(meta()[3]).toBe('Порожньо');
    expect(clearHistory.disabled).toBe(true);
  });
});
