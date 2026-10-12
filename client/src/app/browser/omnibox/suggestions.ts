import { normalizeAddress } from '../../shared/form-field/form-field';
import type { Bookmark } from '../data/bookmarks';
import type { HistoryEntry } from '../data/history';
import { translate } from '../../shared/i18n/i18n';

/**
 * Підказка адресного рядка: що відкриється, як вона виглядає в списку (`title`, `detail`) і що з'явиться в рядку,
 * коли на неї перейти стрілками (`fill`).
 */
export type Suggestion =
  | { readonly kind: 'search'; readonly title: string; readonly detail: string; readonly fill: string; readonly query: string }
  | { readonly kind: 'url'; readonly title: string; readonly detail: string; readonly fill: string; readonly url: string }
  | {
      readonly kind: 'history' | 'bookmark';
      readonly title: string;
      readonly detail: string;
      readonly fill: string;
      readonly url: string;
    }
  | {
      readonly kind: 'tab';
      readonly title: string;
      readonly detail: string;
      readonly fill: string;
      readonly url: string;
      readonly tabId: number;
    };

/** Відкрита вкладка для підказки «Перейти на вкладку». */
export interface OpenTab {
  readonly id: number;
  readonly title: string;
  readonly url: string;
}

export interface SuggestionSources {
  readonly history: readonly HistoryEntry[];
  readonly bookmarks: readonly Bookmark[];
  /** Інші відкриті вкладки вікна (без поточної). */
  readonly tabs: readonly OpenTab[];
  /** Назва пошукової системи: «Пошук у Google». */
  readonly engine: string;
}

/** Скільки підказок з історії, закладок і вкладок разом. */
const LOCAL_LIMIT = 6;

/** Адреса так, як її друкують: без https:// і www., без кінцевої «/». */
export function displayUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Чи підходить запис до введеного: кожне слово є в назві чи адресі. */
function matches(words: readonly string[], title: string, url: string): boolean {
  const haystack = `${title} ${displayUrl(url)}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Наскільки запис підходить: сайт, що починається з введеного, — найвище, далі частіші й свіжіші. */
function score(typed: string, title: string, url: string, visits: number, lastVisit: number, now: number): number {
  const host = hostOf(url);
  const address = displayUrl(url).toLowerCase();
  let points = Math.log2(1 + visits) * 10;
  if (host.startsWith(typed)) {
    points += 100;
    // Головна сторінка сайту — вище за його окремі сторінки.
    points += address === host ? 20 : 0;
  } else if (address.startsWith(typed)) {
    points += 60;
  } else if (
    title
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.startsWith(typed))
  ) {
    points += 30;
  }
  const days = (now - lastVisit) / 86_400_000;
  return points + Math.max(0, 20 - days);
}

/**
 * Підказки з того, що вже є в браузері: перша — що станеться з Enter (перейти на адресу чи шукати), далі відкриті
 * вкладки, закладки й історія без повторів.
 */
export function localSuggestions(input: string, sources: SuggestionSources, now = Date.now()): Suggestion[] {
  const text = input.trim();
  if (!text) {
    return [];
  }
  const typed = text.toLowerCase();
  const words = typed.split(/\s+/);
  const url = normalizeAddress(text);
  const first: Suggestion = url
    ? { kind: 'url', title: displayUrl(url), detail: translate('Перейти на сайт'), fill: text, url }
    : { kind: 'search', title: text, detail: translate('Пошук у {0}', [sources.engine]), fill: text, query: text };

  const seen = new Set<string>(url ? [url] : []);
  const local: { readonly suggestion: Suggestion; readonly score: number }[] = [];
  for (const tab of sources.tabs) {
    if (/^https?:/i.test(tab.url) && matches(words, tab.title, tab.url) && !seen.has(tab.url)) {
      seen.add(tab.url);
      local.push({
        suggestion: {
          kind: 'tab',
          title: tab.title || displayUrl(tab.url),
          detail: translate('Перейти на вкладку'),
          fill: displayUrl(tab.url),
          url: tab.url,
          tabId: tab.id,
        },
        score: 1000 + score(typed, tab.title, tab.url, 0, now, now),
      });
    }
  }
  for (const bookmark of sources.bookmarks) {
    if (matches(words, bookmark.title, bookmark.url) && !seen.has(bookmark.url)) {
      seen.add(bookmark.url);
      local.push({
        suggestion: {
          kind: 'bookmark',
          title: bookmark.title || displayUrl(bookmark.url),
          detail: displayUrl(bookmark.url),
          fill: displayUrl(bookmark.url),
          url: bookmark.url,
        },
        score: 50 + score(typed, bookmark.title, bookmark.url, 0, 0, now),
      });
    }
  }
  // Історія — по адресах: скільки разів і коли востаннє відвідували.
  const visits = new Map<string, { title: string; count: number; last: number }>();
  for (const entry of sources.history) {
    const visit = visits.get(entry.url);
    if (visit) {
      visit.count++;
      visit.title ||= entry.title;
      visit.last = Math.max(visit.last, entry.visitedAt);
    } else {
      visits.set(entry.url, { title: entry.title, count: 1, last: entry.visitedAt });
    }
  }
  for (const [address, visit] of visits) {
    if (!seen.has(address) && /^https?:/i.test(address) && matches(words, visit.title, address)) {
      seen.add(address);
      local.push({
        suggestion: {
          kind: 'history',
          title: visit.title || displayUrl(address),
          detail: displayUrl(address),
          fill: displayUrl(address),
          url: address,
        },
        score: score(typed, visit.title, address, visit.count, visit.last, now),
      });
    }
  }
  local.sort((a, b) => b.score - a.score);
  return [first, ...local.slice(0, LOCAL_LIMIT).map((item) => item.suggestion)];
}

/** Підказки пошукової системи — після своїх, без повторів введеного. */
export function withSearchSuggestions(
  input: string,
  local: readonly Suggestion[],
  remote: readonly string[],
  engine: string
): Suggestion[] {
  const typed = input.trim().toLowerCase();
  const known = new Set(local.filter((item) => item.kind === 'search').map((item) => item.title.toLowerCase()));
  const extra = remote
    .filter((query) => query.toLowerCase() !== typed && !known.has(query.toLowerCase()))
    .slice(0, 4)
    .map((query): Suggestion => ({
      kind: 'search',
      title: query,
      detail: translate('Пошук у {0}', [engine]),
      fill: query,
      query,
    }));
  return [...local, ...extra];
}

/**
 * Автодоповнення в самому рядку, як у Chrome: надрукували «yo» — рядок показує «youtube.com», а дописане виділене.
 * Лише для сайтів, адреса яких починається з надрукованого (без пробілів), і лише з історії й закладок.
 */
export function inlineCompletion(
  input: string,
  suggestions: readonly Suggestion[]
): { readonly text: string; readonly url: string } | null {
  const typed = input.trim();
  if (!typed || /\s/.test(typed) || input !== input.trimStart()) {
    return null;
  }
  for (const suggestion of suggestions) {
    if (suggestion.kind !== 'history' && suggestion.kind !== 'bookmark' && suggestion.kind !== 'tab') {
      continue;
    }
    // Без «/» у надрукованому доповнюємо лише до сайту, а з ним — до всієї адреси.
    const target = typed.includes('/') ? displayUrl(suggestion.url) : hostOf(suggestion.url);
    if (target.toLowerCase().startsWith(typed.toLowerCase()) && target.length > typed.length) {
      const url = typed.includes('/') ? suggestion.url : new URL(suggestion.url).origin + '/';
      return { text: typed + target.slice(typed.length), url };
    }
  }
  return null;
}
