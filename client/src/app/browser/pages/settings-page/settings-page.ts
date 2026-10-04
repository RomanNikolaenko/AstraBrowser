import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  HISTORY_RETENTION,
  SEARCH_ENGINES,
  SearchEngine,
  SettingsStore,
  ThemePreference,
} from '../../../shared/settings/settings';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiSelect } from '../../../shared/ui-select/ui-select';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { ClearDataDialog } from '../../clear-data/clear-data-dialog';
import { DownloadSettingsStore } from '../../data/download-settings';
import { HistoryStore } from '../../data/history';

const plural = new Intl.PluralRules('uk');
const RECORDS: Record<string, string> = { one: 'запис', few: 'записи', many: 'записів', other: 'запису' };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ClearDataDialog, UiIcon, UiSelect, UiSwitch],
  selector: 'app-settings-page',
  styleUrls: ['../internal-page.scss', './settings-page.scss'],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore);
  protected readonly history = inject(HistoryStore);
  protected readonly downloadSettings = inject(DownloadSettingsStore);

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
