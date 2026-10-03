import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../../../shared/settings/settings';
import { DownloadSettings, DownloadSettingsStore } from '../../data/download-settings';
import { SettingsPage } from './settings-page';

/** Налаштування завантажень без Rust: виклики записуються й одразу змінюють стан. */
class FakeDownloadSettings extends DownloadSettingsStore {
  readonly calls: unknown[][] = [];

  set(settings: DownloadSettings | null): void {
    this.state.set(settings);
  }

  override chooseFolder(): Promise<void> {
    this.calls.push(['choose']);
    this.state.update((settings) => settings && { ...settings, folder: 'D:\\Файли', custom: true });
    return Promise.resolve();
  }

  override resetFolder(): Promise<void> {
    this.calls.push(['reset']);
    this.state.update((settings) => settings && { ...settings, folder: 'C:\\Users\\me\\Downloads', custom: false });
    return Promise.resolve();
  }

  override setAsk(ask: boolean): Promise<void> {
    this.calls.push(['ask', ask]);
    this.state.update((settings) => settings && { ...settings, ask });
    return Promise.resolve();
  }

  override openFolder(): Promise<void> {
    this.calls.push(['open']);
    return Promise.resolve();
  }
}

describe('SettingsPage', () => {
  const setup = async (downloads: DownloadSettings | null = null) => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DownloadSettingsStore, useClass: FakeDownloadSettings },
      ],
    }).compileComponents();
    (TestBed.inject(DownloadSettingsStore) as FakeDownloadSettings).set(downloads);

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

  it('should show where downloads go and let the folder be changed', async () => {
    const { element, click } = await setup({ folder: 'C:\\Users\\me\\Downloads', custom: false, ask: false });
    const store = TestBed.inject(DownloadSettingsStore) as FakeDownloadSettings;
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.settings__actions button')].find(
        (node) => node.textContent?.trim() === label
      );
    const folder = () => element.querySelector('.settings__text--wide .page__meta')?.textContent?.trim();

    expect([...element.querySelectorAll('.page__group')].map((group) => group.textContent?.trim())).toContain('Завантаження');
    expect(folder()).toBe('C:\\Users\\me\\Downloads');
    expect(button('Стандартна')).toBeUndefined();

    await click(button('Змінити…'));
    expect(folder()).toBe('D:\\Файли');

    await click(button('Відкрити'));
    await click(button('Стандартна'));
    expect(folder()).toBe('C:\\Users\\me\\Downloads');

    const ask = element.querySelector<HTMLInputElement>('#settings-ask-download');
    expect(ask?.checked).toBe(false);
    await click(ask);
    expect(store.calls).toEqual([['choose'], ['open'], ['reset'], ['ask', true]]);
    expect(ask?.checked).toBe(true);
  });

  it('should hide the download folder outside the app', async () => {
    const { element } = await setup(null);
    expect(element.querySelector('#settings-ask-download')).toBeNull();
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
    localStorage.setItem(
      'astra.history',
      JSON.stringify([1, 2, 3].map((id) => ({ id: `${id}`, url: 'https://a.example', title: 'A', visitedAt: now })))
    );
    const { element, click, meta } = await setup();
    expect(meta()).toEqual([
      '«Як у системі» стежить за темою Windows',
      'Показувати закладки під адресним рядком',
      'Для запитів з адресного рядка й нової вкладки',
      '3 записи',
      'Порожньо · самі файли лишаються на диску',
    ]);

    const clearHistory = element.querySelectorAll<HTMLButtonElement>('.settings__row .page__button')[0];
    await click(clearHistory);
    expect(meta()[3]).toBe('3 записи');

    await click(element.querySelector<HTMLButtonElement>('.confirm-dialog__button--confirm'));
    expect(meta()[3]).toBe('Порожньо');
    expect(clearHistory.disabled).toBe(true);
  });
});
