import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  HISTORY_RETENTION,
  SEARCH_ENGINES,
  SearchEngine,
  SettingsStore,
  TRACKING_PROTECTION,
  ThemePreference,
} from '../../../shared/settings/settings';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { UiSelect } from '../../../shared/ui-select/ui-select';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { ClearDataDialog } from '../../clear-data/clear-data-dialog';
import { DNS_MODES, DNS_PROVIDERS, DnsMode, DnsProvider, DnsSettings, DnsStore } from '../../data/dns';
import { DownloadSettingsStore } from '../../data/download-settings';
import { HistoryStore } from '../../data/history';
import { TrackingStore } from '../../data/tracking';

const plural = new Intl.PluralRules('uk');
const RECORDS: Record<string, string> = { one: 'запис', few: 'записи', many: 'записів', other: 'запису' };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ClearDataDialog, UiIcon, UiInput, UiSelect, UiSwitch],
  selector: 'app-settings-page',
  styleUrls: ['../internal-page.scss', './settings-page.scss'],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore);
  protected readonly history = inject(HistoryStore);
  protected readonly downloadSettings = inject(DownloadSettingsStore);
  protected readonly tracking = inject(TrackingStore);
  protected readonly dns = inject(DnsStore);
  protected readonly dnsModes = DNS_MODES;
  protected readonly dnsProviders = DNS_PROVIDERS;
  /** Вибраний у списку постачальник: «Власний…» діє, лише коли збережуть його адресу. */
  protected readonly dnsProvider = signal<DnsProvider>('cloudflare');
  protected readonly dnsCustom = signal('');
  protected readonly dnsError = signal<string | null>(null);

  constructor() {
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
  protected readonly trackingLevels = TRACKING_PROTECTION;
  protected readonly trackingHint = computed(
    () => TRACKING_PROTECTION.find((level) => level.value === this.settings.trackingProtection())?.hint ?? ''
  );

  protected readonly themes: readonly { readonly value: ThemePreference; readonly label: string; readonly icon: string }[] = [
    { value: 'system', label: 'Як у системі', icon: 'monitor' },
    { value: 'light', label: 'Світла', icon: 'sun' },
    { value: 'dark', label: 'Темна', icon: 'moon' },
  ];

  protected readonly engines = Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({
    value: value as SearchEngine,
    label: engine.label,
  }));

  protected readonly retention = HISTORY_RETENTION.map((option) => ({ value: `${option.days}`, label: option.label }));

  protected setHistoryDays(value: string | undefined): void {
    const days = Number(value);
    if (value !== undefined && Number.isFinite(days)) {
      this.settings.historyDays.set(days);
    }
  }

  protected records(count: number): string {
    return count ? `${count} ${RECORDS[plural.select(count)]}` : 'Порожньо';
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
      this.dnsError.set(typeof error === 'string' ? error : 'Не вдалося зберегти налаштування DNS.');
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
