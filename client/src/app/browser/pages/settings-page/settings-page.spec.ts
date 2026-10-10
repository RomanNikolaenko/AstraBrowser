import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SettingsStore } from '../../../shared/settings/settings';
import { DnsSettings, DnsStore } from '../../data/dns';
import { DownloadSettings, DownloadSettingsStore } from '../../data/download-settings';
import { TrackingStore } from '../../data/tracking';
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

/** DNS через HTTPS без Rust: `applied` — з чим «запущено» браузер; null — поза застосунком. */
class FakeDns extends DnsStore {
  readonly calls: unknown[][] = [];
  applied: DnsSettings | null = null;

  override load(): Promise<void> {
    this.state.set(this.applied && { settings: this.applied, restartNeeded: false });
    return Promise.resolve();
  }

  override save(settings: DnsSettings): Promise<void> {
    this.calls.push(['save', settings]);
    this.state.set({ settings, restartNeeded: JSON.stringify(settings) !== JSON.stringify(this.applied) });
    return Promise.resolve();
  }

  override restart(): Promise<void> {
    this.calls.push(['restart']);
    return Promise.resolve();
  }
}

describe('SettingsPage', () => {
  const setup = async (downloads: DownloadSettings | null = null, dns: DnsSettings | null = null) => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: DownloadSettingsStore, useClass: FakeDownloadSettings },
        { provide: DnsStore, useClass: FakeDns },
      ],
    }).compileComponents();
    (TestBed.inject(DownloadSettingsStore) as FakeDownloadSettings).set(downloads);
    (TestBed.inject(DnsStore) as FakeDns).applied = dns;

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
    const folder = () => element.querySelector('.settings__text--wide .page__meta[title]')?.textContent?.trim();

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

  it('should choose the tracking protection, the privacy signal and give the protection back to sites', async () => {
    const { fixture, element, click } = await setup();
    const settings = TestBed.inject(SettingsStore);
    const tracking = TestBed.inject(TrackingStore);
    const hint = () => element.querySelector('#settings-privacy + .page__list .settings__hint')?.textContent?.trim();

    expect(hint()).toContain('Сайти працюють як звичайно');
    await click(element.querySelector<HTMLInputElement>('input[name="tracking-protection"][value="strict"]'));
    expect(settings.trackingProtection()).toBe('strict');
    expect(hint()).toContain('Деякі сайти можуть працювати неправильно');

    await click(element.querySelector<HTMLInputElement>('#settings-gpc'));
    expect(settings.globalPrivacyControl()).toBe(false);

    tracking.setProtected('https://www.twitch.tv/', false);
    await fixture.whenStable();
    const exception = element.querySelector('.settings__row--nested');
    expect(exception?.querySelector('.page__name')?.textContent?.trim()).toBe('twitch.tv');
    await click(exception?.querySelector('button'));
    expect(tracking.exceptions()).toEqual([]);
    expect(element.querySelector('.settings__row--nested')).toBeNull();
  });

  it('should hide DNS over HTTPS outside the app', async () => {
    const { element } = await setup();
    expect(element.querySelector('.dns')).toBeNull();
  });

  it('should choose how DNS over HTTPS works and ask to restart the browser for it', async () => {
    const { element, click } = await setup(null, { mode: 'default', provider: 'cloudflare', custom: '' });
    const dns = TestBed.inject(DnsStore) as FakeDns;
    const mode = (value: string) => element.querySelector<HTMLInputElement>(`input[name="dns-mode"][value="${value}"]`);
    const notice = () => element.querySelector('.dns__notice');

    expect(mode('default')?.checked).toBe(true);
    expect(element.querySelector('#settings-dns-provider')).toBeNull();
    expect(notice()).toBeNull();

    await click(mode('max'));
    expect(dns.calls.at(-1)).toEqual(['save', { mode: 'max', provider: 'cloudflare', custom: '' }]);
    expect(element.querySelector('#settings-dns-provider')?.textContent?.trim()).toBe('Cloudflare');
    expect(notice()?.textContent).toContain('після перезапуску браузера');

    // Власний постачальник — лише коли збережуть його адресу.
    await click(element.querySelector<HTMLElement>('#settings-dns-provider'));
    const options = [...element.querySelectorAll<HTMLElement>('[role="option"]')];
    await click(options.find((option) => option.textContent?.includes('Власний')));
    expect(dns.calls).toHaveLength(1);
    const custom = element.querySelector<HTMLInputElement>('#settings-dns-custom') as HTMLInputElement;
    custom.value = ' https://doh.example.net/dns-query ';
    custom.dispatchEvent(new Event('input'));
    await click(element.querySelector<HTMLButtonElement>('.dns__custom button'));
    expect(dns.calls.at(-1)).toEqual(['save', { mode: 'max', provider: 'custom', custom: 'https://doh.example.net/dns-query' }]);

    await click(element.querySelector<HTMLButtonElement>('.dns__notice button'));
    expect(dns.calls.at(-1)).toEqual(['restart']);

    await click(mode('off'));
    expect(dns.calls.at(-1)).toEqual(['save', { mode: 'off', provider: 'custom', custom: 'https://doh.example.net/dns-query' }]);
    expect(element.querySelector('#settings-dns-provider')).toBeNull();
  });

  it('should toggle the bookmarks bar', async () => {
    const { element, click } = await setup();
    const toggle = element.querySelector<HTMLInputElement>('#settings-bookmarks-bar');
    expect(toggle?.checked).toBe(true);

    await click(toggle);

    expect(TestBed.inject(SettingsStore).showBookmarksBar()).toBe(false);
  });

  it('should clear the browsing data of the chosen time, like Chrome', async () => {
    const now = Date.now();
    localStorage.setItem(
      'astra.history',
      JSON.stringify([
        { id: 'old', url: 'https://old.example', title: 'Давно', visitedAt: now - 3 * 3_600_000 },
        { id: 'new', url: 'https://new.example', title: 'Щойно', visitedAt: now - 60_000 },
      ])
    );
    const { element, click } = await setup();
    const clearMeta = () =>
      [...element.querySelectorAll('.settings__row')]
        .find((row) => row.textContent?.includes('Очистити дані перегляду'))
        ?.querySelector('.page__meta')
        ?.textContent?.trim();
    expect(element.querySelector('#settings-history-days')?.textContent?.trim()).toBe('90 днів');
    expect(clearMeta()).toBe('Історія (2 записи), файли cookie, кеш, дані форм і налаштування сайтів');

    await click(
      [...element.querySelectorAll<HTMLButtonElement>('.page__button')].find((button) =>
        button.textContent?.includes('Очистити…')
      )
    );
    const names = [...element.querySelectorAll('.clear-data__name')].map((name) => name.textContent?.trim());
    expect(names).toEqual([
      'Історію переглядів та завантажень',
      'Файли cookie та дані сайтів',
      'Тимчасові кешовані файли та сторінки',
      'Збережена інформація заповнених форм',
      'Налаштування сайтів',
    ]);
    const checks = [...element.querySelectorAll<HTMLInputElement>('.clear-data__check')].map((check) => check.checked);
    expect(checks).toEqual([true, true, true, true, false]);

    // За останню годину — лише свіжий запис.
    await click(element.querySelector<HTMLButtonElement>('.clear-data__button--primary'));
    await new Promise((resolve) => setTimeout(resolve));
    expect(clearMeta()).toBe('Історія (1 запис), файли cookie, кеш, дані форм і налаштування сайтів');
  });
});
