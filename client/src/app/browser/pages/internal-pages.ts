export type InternalPage = 'history' | 'downloads' | 'bookmarks' | 'passwords' | 'notes' | 'extensions' | 'settings' | 'help';

/** Що показує вкладка: нову вкладку чи внутрішню сторінку браузера. */
export type TabPage = 'new-tab' | InternalPage;

export const TAB_PAGES: Readonly<Record<TabPage, { readonly title: string; readonly favicon: string; readonly url: string }>> = {
  'new-tab': { title: 'Нова вкладка', favicon: 'favicon-home', url: '' },
  history: { title: 'Історія', favicon: 'clock', url: 'astra://history' },
  downloads: { title: 'Завантаження', favicon: 'download', url: 'astra://downloads' },
  bookmarks: { title: 'Закладки', favicon: 'star', url: 'astra://bookmarks' },
  passwords: { title: 'Паролі', favicon: 'key', url: 'astra://passwords' },
  notes: { title: 'Нотатки', favicon: 'notes', url: 'astra://notes' },
  extensions: { title: 'Розширення', favicon: 'puzzle', url: 'astra://extensions' },
  settings: { title: 'Налаштування', favicon: 'settings', url: 'astra://settings' },
  help: { title: 'Довідка', favicon: 'help', url: 'astra://help' },
};

/** Внутрішня сторінка за адресою astra://… або `null`, якщо це не вона. */
export function internalPageFor(url: string): InternalPage | null {
  const entry = Object.entries(TAB_PAGES).find(([page, info]) => page !== 'new-tab' && info.url === url);
  return entry ? (entry[0] as InternalPage) : null;
}

/** Гарячі клавіші, що справді працюють; показуються на сторінці довідки. */
export const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly action: string }[] = [
  { keys: ['Ctrl', 'T'], action: 'Нова вкладка' },
  { keys: ['Ctrl', 'N'], action: 'Нове вікно' },
  { keys: ['Ctrl', 'Shift', 'N'], action: 'Приватне вікно' },
  { keys: ['Ctrl', 'J'], action: 'Завантаження' },
  { keys: ['Ctrl', 'F'], action: 'Знайти на сторінці' },
  { keys: ['Ctrl', 'Shift', ']'], action: 'Картинка в картинці (відео YouTube)' },
  { keys: ['Ctrl', 'Shift', 'S'], action: 'Скріншот сторінки' },
  { keys: ['Enter'], action: 'Наступний збіг у пошуку на сторінці' },
  { keys: ['Shift', 'Enter'], action: 'Попередній збіг у пошуку на сторінці' },
  { keys: ['Esc'], action: 'Закрити пошук або меню' },
  { keys: ['Ctrl', 'P'], action: 'Друк' },
];

const DAY = 24 * 60 * 60 * 1000;
const dateFormat = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('uk-UA', { hour: '2-digit', minute: '2-digit' });
const sizeFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });

/** Групує записи за днями: «Сьогодні», «Вчора», далі дата. Порядок записів зберігається. */
export function groupByDay<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  now = Date.now()
): { label: string; items: T[] }[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const time = timeOf(item);
    const label = time >= startOfToday ? 'Сьогодні' : time >= startOfToday - DAY ? 'Вчора' : dateFormat.format(time);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups].map(([label, groupItems]) => ({ label, items: groupItems }));
}

export function formatTime(time: number): string {
  return timeFormat.format(time);
}

export function formatSize(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${sizeFormat.format(value)} ${units[unit]}`;
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Пошук без урахування регістру по будь-якому з полів. */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLocaleLowerCase('uk');
  return !needle || fields.some((field) => field?.toLocaleLowerCase('uk').includes(needle));
}
