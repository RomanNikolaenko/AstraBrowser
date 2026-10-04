import { Injectable, computed, inject } from '@angular/core';
import { SettingsStore } from '../../shared/settings/settings';
import { accountSignal } from '../../shared/storage/stored-signal';

/** Що саме заблоковано (server/src/tracking.rs, Category). */
export type TrackerCategory = 'tracking' | 'social' | 'cryptomining';

/** Елемент стеження, заблокований на сторінці: категорія й хост, куди сторінка хотіла звернутися. */
export interface BlockedTracker {
  readonly category: TrackerCategory;
  readonly host: string;
}

/** Правила захисту від стеження для вікна (server/src/tracking.rs, Rules). */
export interface TrackingRules {
  readonly level: 'standard' | 'strict' | 'off';
  readonly gpc: boolean;
  readonly exceptions: readonly string[];
}

/** Як категорії називаються й пояснюються в панелі захисту — у порядку показу. */
export const TRACKER_CATEGORIES: readonly {
  readonly category: TrackerCategory;
  readonly icon: string;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    category: 'tracking',
    icon: 'eye',
    label: 'Елементи стеження',
    hint: 'Аналітика й рекламні мітки, що впізнають вас на різних сайтах',
  },
  {
    category: 'social',
    icon: 'user',
    label: 'Елементи стеження соцмереж',
    hint: 'Кнопки «Поділитися», вбудовані дописи й пікселі соцмереж',
  },
  {
    category: 'cryptomining',
    icon: 'bolt',
    label: 'Криптомайнери',
    hint: 'Скрипти, що добувають криптовалюту коштом вашого комп’ютера',
  },
];

/** Хост сайту для винятків — у нижньому регістрі й без www. (як normalize_site у server/src/adblock.rs). */
export function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Чи стосується виняток для сайту `site` хоста `host` — самого сайту чи його піддомену (covers у tracking.rs). */
function covers(site: string, host: string): boolean {
  const bare = host.replace(/^www\./, '');
  return bare === site || bare.endsWith(`.${site}`);
}

/**
 * Захист від стеження: рівень і Global Privacy Control — у налаштуваннях, а сайти, яким захист вимкнули, — тут
 * (дані облікового запису, синхронізуються). Саме блокування — у server/src/tracking.rs.
 */
@Injectable({ providedIn: 'root' })
export class TrackingStore {
  private readonly settings = inject(SettingsStore);
  /** Сайти (хост без www.), яким захист вимкнули, — разом з піддоменами. */
  readonly exceptions = accountSignal<readonly string[]>('astra.tracking.exceptions', []);

  readonly rules = computed<TrackingRules>(() => ({
    level: this.settings.trackingProtection(),
    gpc: this.settings.globalPrivacyControl(),
    exceptions: this.exceptions(),
  }));

  /** Чи захищено сайт з адресою `url` (`false` — захист вимкнено взагалі чи для цього сайту). */
  protects(url: string): boolean {
    const host = siteOf(url);
    return !!host && this.settings.trackingProtection() !== 'off' && !this.exceptions().some((site) => covers(site, host));
  }

  /** Вмикає чи вимикає захист для сайту з адресою `url` (увімкнення прибирає й винятки для всього домену). */
  setProtected(url: string, enabled: boolean): void {
    const host = siteOf(url);
    if (!host) {
      return;
    }
    this.exceptions.update((sites) =>
      enabled ? sites.filter((site) => !covers(site, host)) : sites.includes(host) ? sites : [...sites, host]
    );
  }

  /** Повертає захист сайтові зі списку винятків. */
  removeException(site: string): void {
    this.exceptions.update((sites) => sites.filter((item) => item !== site));
  }
}
