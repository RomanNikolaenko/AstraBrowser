import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SEARCH_ENGINES, SearchEngine, SettingsStore, ThemePreference } from '../../../shared/settings/settings';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { ConfirmDialog } from '../../confirm-dialog/confirm-dialog';
import { DownloadSettingsStore } from '../../data/download-settings';
import { DownloadsStore } from '../../data/downloads';
import { HistoryStore } from '../../data/history';

const plural = new Intl.PluralRules('uk');
const RECORDS: Record<string, string> = { one: 'запис', few: 'записи', many: 'записів', other: 'запису' };

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConfirmDialog, UiIcon],
  selector: 'app-settings-page',
  styleUrls: ['../internal-page.scss', './settings-page.scss'],
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  protected readonly settings = inject(SettingsStore);
  protected readonly history = inject(HistoryStore);
  protected readonly downloads = inject(DownloadsStore);
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

  protected setAsk(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.downloadSettings.setAsk(input.checked).catch(() => (input.checked = !input.checked));
  }

  protected setBookmarksBar(event: Event): void {
    this.settings.showBookmarksBar.set((event.target as HTMLInputElement).checked);
  }
}
