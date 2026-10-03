import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AdBlockStatus, AdBlockStore } from '../../data/adblock';
import { ExtensionsPage } from './extensions-page';

/** Блокувальник без Rust: стан задає тест, а виклики записуються. */
class FakeAdBlock extends AdBlockStore {
  readonly calls: unknown[][] = [];

  set(status: AdBlockStatus): void {
    this.state.set(status);
  }

  fail(): void {
    this.failure.set(true);
  }

  override setEnabled(enabled: boolean): Promise<void> {
    this.calls.push(['enabled', enabled]);
    return Promise.resolve();
  }

  override setSiteEnabled(host: string, enabled: boolean): Promise<void> {
    this.calls.push(['site', host, enabled]);
    return Promise.resolve();
  }

  override update(): Promise<void> {
    this.calls.push(['update']);
    return Promise.resolve();
  }
}

const READY: AdBlockStatus = {
  enabled: true,
  disabledSites: [],
  ready: true,
  updating: false,
  updatedAt: new Date(2026, 9, 3, 14, 5).getTime(),
  error: null,
  lists: ['EasyList', 'EasyPrivacy', 'uBlock filters'],
};

describe('ExtensionsPage', () => {
  const setup = async (status: AdBlockStatus | null) => {
    await TestBed.configureTestingModule({
      imports: [ExtensionsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AdBlockStore, useClass: FakeAdBlock }],
    }).compileComponents();

    const adblock = TestBed.inject(AdBlockStore) as FakeAdBlock;
    if (status) {
      adblock.set(status);
    }
    const fixture = TestBed.createComponent(ExtensionsPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const toggle = element.querySelector('[role="switch"]') as HTMLInputElement;
    const state = () => element.querySelector('[role="status"]')?.textContent?.trim();
    return { fixture, adblock, element, toggle, state };
  };

  it('should say the blocker needs the app outside of it', async () => {
    const { element, toggle, state } = await setup(null);

    expect(element.querySelector('.extension__name')?.textContent).toBe('Блокувальник реклами');
    expect(state()).toBe('Працює лише в застосунку Astra Browser');
    expect(toggle.disabled).toBe(true);
    expect(element.querySelector('.extension__lists')).toBeNull();
  });

  it('should say when the app does not answer instead of claiming it is not the app', async () => {
    const inApp = () => Object.assign(new FakeAdBlock(), { available: true });
    TestBed.overrideProvider(AdBlockStore, { useFactory: inApp });
    const { fixture, adblock, element, toggle, state } = await setup(null);

    expect(state()).toBe('Завантаження…');
    expect(toggle.disabled).toBe(true);

    adblock.fail();
    await fixture.whenStable();
    expect(state()).toBe('Блокувальник не відповідає — перезапустіть Astra Browser');
    expect(element.querySelector('[role="status"]')?.classList).toContain('page__meta--error');
  });

  it('should show the filter lists and when they were updated', async () => {
    const { element, toggle, state } = await setup(READY);

    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(state()).toBe('Списки оновлено 3 жовтня о 14:05');
    expect([...element.querySelectorAll('.extension__chip')].map((chip) => chip.textContent)).toEqual([
      'EasyList',
      'EasyPrivacy',
      'uBlock filters',
    ]);
    // Списки згорнуті, доки їх не розкриють.
    const accordion = element.querySelector('.extension__accordion .ui-accordion__trigger') as HTMLButtonElement;
    expect(accordion.querySelector('.ui-accordion__heading')?.textContent).toBe('Списки фільтрів');
    expect(accordion.querySelector('.ui-accordion__badge')?.textContent).toBe('3');
    expect(accordion.getAttribute('aria-expanded')).toBe('false');
    expect([...element.querySelectorAll('.extension__hint')].at(-1)?.textContent).toContain('Немає');
  });

  it('should turn the blocker off and update the lists on demand', async () => {
    const { adblock, element, toggle } = await setup(READY);

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    element.querySelector<HTMLButtonElement>('.extension__update')?.click();

    expect(adblock.calls).toEqual([['enabled', false], ['update']]);
  });

  it('should report updating and failed updates', async () => {
    const { fixture, adblock, element, state } = await setup({ ...READY, updating: true });
    const updateButton = () => element.querySelector('.extension__update') as HTMLButtonElement;

    expect(state()).toBe('Оновлення списків фільтрів…');
    expect(updateButton().disabled).toBe(true);

    adblock.set({ ...READY, error: 'easylist.to: timeout' });
    await fixture.whenStable();
    expect(state()).toBe('Не вдалося оновити списки: easylist.to: timeout');
    expect(element.querySelector('[role="status"]')?.classList).toContain('page__meta--error');
    expect(updateButton().disabled).toBe(false);
  });

  it('should list sites without blocking and turn blocking back on for them', async () => {
    const { adblock, element } = await setup({ ...READY, disabledSites: ['example.com', 'news.site'] });

    expect([...element.querySelectorAll('.extension__sites .page__name')].map((name) => name.textContent)).toEqual([
      'example.com',
      'news.site',
    ]);

    element.querySelector<HTMLButtonElement>('[aria-label="Знову блокувати рекламу на news.site"]')?.click();
    expect(adblock.calls).toEqual([['site', 'news.site', true]]);
  });
});
