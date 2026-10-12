import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { UiSelect, UiSelectOption } from '../../shared/ui-select/ui-select';
import { AutoplayStore } from '../data/autoplay';
import { DownloadsStore } from '../data/downloads';
import { HistoryStore } from '../data/history';
import { formatNumber, tr, translate, TranslatePipe } from '../../shared/i18n/i18n';

/** За який час очистити. */
export type ClearRange = 'hour' | 'day' | 'week' | 'month' | 'all';

const RANGES: readonly (UiSelectOption<ClearRange> & { readonly hours: number })[] = [
  { value: 'hour', label: tr('останню годину'), hours: 1 },
  { value: 'day', label: tr('останні 24 години'), hours: 24 },
  { value: 'week', label: tr('останні 7 днів'), hours: 24 * 7 },
  { value: 'month', label: tr('останні 4 тижні'), hours: 24 * 28 },
  { value: 'all', label: tr('увесь час'), hours: 0 },
];

/** Що очистити — як у server/src/webview2.rs (ClearKinds), плюс історія й завантаження самого браузера. */
interface ClearChoice {
  readonly history: boolean;
  readonly siteData: boolean;
  readonly cache: boolean;
  readonly autofill: boolean;
  readonly settings: boolean;
}

interface BrowsingDataSizes {
  readonly siteData: number;
  readonly cache: number;
}

/** «11,0 МБ», «1,0 ГБ». */
export function formatSize(bytes: number): string {
  const units = [translate('Б'), translate('КБ'), translate('МБ'), translate('ГБ'), translate('ТБ')];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0
    ? `${value} ${units[0]}`
    : `${formatNumber(value, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} ${units[unit]}`;
}

/** Що чистить WebView2 — як у server/src/webview2.rs (ClearKinds). */
export interface SiteDataKinds {
  readonly siteData: boolean;
  readonly cache: boolean;
  readonly history: boolean;
  readonly autofill: boolean;
  readonly settings: boolean;
}

/**
 * Очищає дані сайтів у WebView2 (server/src/browsing_data.rs), змінені від `since` (мс; 0 — за весь час).
 * `visited` — адреси з історії: у профілі, спільному з інтерфейсом браузера, localStorage їхніх сайтів чиститься окремо.
 */
export async function clearSiteData(kinds: SiteDataKinds, since: number, visited: readonly string[]): Promise<void> {
  const origins = [...new Set(visited.map(originOf))].filter((origin): origin is string => !!origin);
  await commands.browsingDataClear(kinds, since / 1000, origins);
}

/** Початок проміжку (мс); 0 — увесь час. */
export function rangeStart(range: ClearRange, now = Date.now()): number {
  const hours = RANGES.find((item) => item.value === range)?.hours ?? 0;
  return hours ? now - hours * 3_600_000 : 0;
}

/**
 * «Очистити дані перегляду і файли cookie», як у Chrome й Edge: за який час і що саме — історію й завантаження,
 * cookies і дані сайтів, кеш, автозаповнення форм, налаштування сайтів. Дані сайтів і кеш чистить WebView2
 * (server/src/browsing_data.rs), а історію, список завантажень і правила автовідтворення — сам браузер.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiSelect],
  selector: 'app-clear-data-dialog',
  styleUrl: './clear-data-dialog.scss',
  templateUrl: './clear-data-dialog.html',
})
export class ClearDataDialog {
  private readonly history = inject(HistoryStore);
  private readonly downloads = inject(DownloadsStore);
  private readonly autoplay = inject(AutoplayStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly ranges = RANGES;
  protected readonly range = signal<ClearRange>('hour');
  protected readonly choice = signal<ClearChoice>({
    history: true,
    siteData: true,
    cache: true,
    autofill: true,
    settings: false,
  });
  /** null — розміри ще рахуються (чи поза застосунком). */
  protected readonly sizes = signal<BrowsingDataSizes | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly nothing = computed(() => !Object.values(this.choice()).some(Boolean));

  show(): void {
    this.error.set(null);
    this.busy.set(false);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
    this.sizes.set(null);
    if (isTauri()) {
      commands
        .browsingDataSizes()
        .then((sizes) => this.sizes.set(sizes))
        .catch(() => undefined);
    }
  }

  protected hide(): void {
    this.dialog().nativeElement.close?.();
  }

  protected toggle(key: keyof ClearChoice, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.choice.update((choice) => ({ ...choice, [key]: checked }));
  }

  protected setRange(range: ClearRange | undefined): void {
    if (range) {
      this.range.set(range);
    }
  }

  protected size(bytes: number | undefined): string {
    return bytes ? ` (${formatSize(bytes)})` : '';
  }

  protected async clear(): Promise<void> {
    if (this.busy() || this.nothing()) {
      return;
    }
    const choice = this.choice();
    const since = rangeStart(this.range());
    // Сайти з історії за цей час — їхній localStorage чиститься окремо (спільний з браузером профіль WebView2).
    const visited = this.history
      .entries()
      .filter((entry) => entry.visitedAt >= since)
      .map((entry) => entry.url);
    this.busy.set(true);
    this.error.set(null);
    try {
      if (isTauri() && (choice.siteData || choice.cache || choice.autofill || choice.settings || choice.history)) {
        const kinds = {
          siteData: choice.siteData,
          cache: choice.cache,
          history: choice.history,
          autofill: choice.autofill,
          settings: choice.settings,
        };
        await clearSiteData(kinds, since, visited);
      }
      if (choice.history) {
        this.history.removeSince(since);
        this.downloads.removeSince(since);
      }
      if (choice.settings) {
        this.autoplay.reset();
      }
      this.hide();
    } catch (error) {
      this.error.set(
        typeof error === 'string'
          ? translate('Не вдалося очистити: {0}', [error])
          : translate('Не вдалося очистити дані. Спробуйте ще раз.')
      );
    } finally {
      this.busy.set(false);
    }
  }
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}
