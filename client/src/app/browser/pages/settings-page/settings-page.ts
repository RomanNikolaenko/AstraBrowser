import { ChangeDetectionStrategy, Component, HostListener, computed, inject, signal } from '@angular/core';
import {
  HISTORY_RETENTION,
  SEARCH_ENGINES,
  SearchEngine,
  SLEEP_TABS,
  SettingsStore,
  StartupPage,
  TRACKING_PROTECTION,
  ThemePreference,
} from '../../../shared/settings/settings';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { UiSelect } from '../../../shared/ui-select/ui-select';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { ClearDataDialog } from '../../clear-data/clear-data-dialog';
import { DefaultBrowserStore } from '../../data/default-browser';
import { DNS_MODES, DNS_PROVIDERS, DnsMode, DnsProvider, DnsSettings, DnsStore } from '../../data/dns';
import { DownloadSettingsStore } from '../../data/download-settings';
import { DOWNLOADS_LIMIT } from '../../data/downloads';
import { HISTORY_LIMIT, HistoryStore } from '../../data/history';
import { TrackingStore } from '../../data/tracking';
import {
  I18n,
  LANGUAGE_NAMES,
  LanguagePreference,
  formatNumber,
  plural,
  tr,
  translate,
  TranslatePipe,
} from '../../../shared/i18n/i18n';
import { IS_LINUX } from '../../../shared/platform/platform';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ClearDataDialog, UiIcon, UiInput, UiSelect, UiSwitch],
  selector: 'app-settings-page',
  styleUrls: ['../internal-page.scss', './settings-page.scss'],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore);
  protected readonly i18n = inject(I18n);
  protected readonly history = inject(HistoryStore);
  protected readonly downloadSettings = inject(DownloadSettingsStore);
  protected readonly tracking = inject(TrackingStore);
  protected readonly dns = inject(DnsStore);
  protected readonly defaultBrowser = inject(DefaultBrowserStore);
  /** У Linux немає того, що дає лише WebView2 (SmartScreen). */
  protected readonly linux = IS_LINUX;
  /** «Параметри Windows» відкрили — підказуємо, що там натиснути. */
  protected readonly defaultBrowserAsked = signal(false);
  protected readonly defaultBrowserError = signal<string | null>(null);
  protected readonly dnsModes = DNS_MODES;
  protected readonly dnsProviders = DNS_PROVIDERS;
  /** Вибраний у списку постачальник: «Власний…» діє, лише коли збережуть його адресу. */
  protected readonly dnsProvider = signal<DnsProvider>('cloudflare');
  protected readonly dnsCustom = signal('');
  protected readonly dnsError = signal<string | null>(null);

  constructor() {
    void this.defaultBrowser.refresh();
    void this.dns
      .load()
      .then(() => {
        const settings = this.dns.state()?.settings;
        if (settings) {
          this.dnsProvider.set(settings.provider);
          this.dnsCustom.set(settings.custom);
        }
      })
      .catch(() => undefined);
  }
  /** Повернулися з «Параметрів Windows» — чи вибрали там Astra. */
  @HostListener('window:focus')
  protected onWindowFocus(): void {
    void this.defaultBrowser.refresh();
  }

  protected async makeDefaultBrowser(): Promise<void> {
    this.defaultBrowserError.set(null);
    try {
      await this.defaultBrowser.openSettings();
      // У Linux Astra вже вибрано, а у Windows вибирають у «Параметрах», що відкрилися.
      if (this.linux) {
        await this.defaultBrowser.refresh();
      } else {
        this.defaultBrowserAsked.set(true);
      }
    } catch (error) {
      this.defaultBrowserError.set(typeof error === 'string' ? error : translate('Не вдалося відкрити «Параметри Windows».'));
    }
  }

  protected readonly trackingLevels = TRACKING_PROTECTION;
  protected readonly trackingHint = computed(
    () => TRACKING_PROTECTION.find((level) => level.value === this.settings.trackingProtection())?.hint ?? ''
  );

  /** «Як у системі» перекладається, назви мов — завжди своєю мовою. */
  protected readonly languages: readonly {
    readonly value: LanguagePreference;
    readonly label: string;
    readonly translated: boolean;
  }[] = [
    { value: 'system', label: tr('Як у системі'), translated: true },
    { value: 'uk', label: LANGUAGE_NAMES.uk, translated: false },
    { value: 'en', label: LANGUAGE_NAMES.en, translated: false },
  ];

  protected readonly themes: readonly { readonly value: ThemePreference; readonly label: string; readonly icon: string }[] = [
    { value: 'system', label: tr('Як у системі'), icon: 'monitor' },
    { value: 'light', label: tr('Світла'), icon: 'sun' },
    { value: 'dark', label: tr('Темна'), icon: 'moon' },
  ];

  protected readonly startupOptions: readonly { readonly value: StartupPage; readonly label: string }[] = [
    { value: 'restore', label: tr('Продовжити, де зупинилися') },
    { value: 'new-tab', label: tr('Нову вкладку') },
  ];

  protected readonly engines = Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({
    value: value as SearchEngine,
    label: engine.label,
  }));

  protected readonly sleepOptions = SLEEP_TABS.map((option) => ({ value: `${option.minutes}`, label: option.label }));

  protected setSleepTabs(value: string | undefined): void {
    const minutes = Number(value);
    if (value !== undefined && Number.isFinite(minutes)) {
      this.settings.sleepTabsAfter.set(minutes);
    }
  }

  /** Межа історії числом, як пишуть мовою інтерфейсу (10 000 чи 10,000). */
  protected readonly historyLimit = () => formatNumber(HISTORY_LIMIT);
  protected readonly retention = HISTORY_RETENTION.map((option) => ({ value: `${option.days}`, label: option.label }));

  protected setHistoryDays(value: string | undefined): void {
    const days = Number(value);
    if (value !== undefined && Number.isFinite(days)) {
      this.settings.historyDays.set(days);
    }
  }

  protected readonly downloadsLimit = () => formatNumber(DOWNLOADS_LIMIT);

  protected setDownloadsDays(value: string | undefined): void {
    const days = Number(value);
    if (value !== undefined && Number.isFinite(days)) {
      this.settings.downloadsDays.set(days);
    }
  }

  protected records(count: number): string {
    return count
      ? plural(count, ['{0} запис', '{0} записи', '{0} записів'], ['{0} entry', '{0} entries'])
      : translate('Порожньо');
  }

  protected setDnsMode(mode: DnsMode): void {
    const settings = this.dns.state()?.settings;
    if (settings) {
      // Власний постачальник без адреси — ще не вибраний: до того посилений і максимальний захист — через Cloudflare.
      const provider = settings.provider === 'custom' && !settings.custom ? 'cloudflare' : settings.provider;
      void this.saveDns({ ...settings, mode, provider });
    }
  }

  protected setDnsProvider(provider: DnsProvider | undefined): void {
    const settings = this.dns.state()?.settings;
    if (!settings || !provider) {
      return;
    }
    this.dnsProvider.set(provider);
    this.dnsError.set(null);
    if (provider !== 'custom') {
      void this.saveDns({ ...settings, provider });
    }
  }

  protected saveDnsCustom(event: Event): void {
    event.preventDefault();
    const settings = this.dns.state()?.settings;
    if (settings) {
      void this.saveDns({ ...settings, provider: 'custom', custom: this.dnsCustom().trim() });
    }
  }

  protected restartBrowser(): void {
    void this.dns.restart().catch(() => undefined);
  }

  private async saveDns(settings: DnsSettings): Promise<void> {
    this.dnsError.set(null);
    try {
      await this.dns.save(settings);
    } catch (error) {
      this.dnsError.set(typeof error === 'string' ? error : translate('Не вдалося зберегти налаштування DNS.'));
    }
  }

  protected chooseFolder(): void {
    void this.downloadSettings.chooseFolder().catch(() => undefined);
  }

  protected resetFolder(): void {
    void this.downloadSettings.resetFolder().catch(() => undefined);
  }

  protected openFolder(): void {
    void this.downloadSettings.openFolder().catch(() => undefined);
  }

  protected setAsk(ask: boolean): void {
    void this.downloadSettings.setAsk(ask).catch(() => undefined);
  }
}
