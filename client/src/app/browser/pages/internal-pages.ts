import { formatDate, formatNumber, tr, translate } from '../../shared/i18n/i18n';
export type InternalPage =
  | 'history'
  | 'downloads'
  | 'bookmarks'
  | 'passwords'
  | 'notes'
  | 'profile'
  | 'personalization'
  | 'extensions'
  | 'settings'
  | 'help';

/** Що показує вкладка: нову вкладку чи внутрішню сторінку браузера. */
export type TabPage = 'new-tab' | InternalPage;

export const TAB_PAGES: Readonly<Record<TabPage, { readonly title: string; readonly favicon: string; readonly url: string }>> = {
  'new-tab': { title: tr('Нова вкладка'), favicon: 'favicon-home', url: '' },
  history: { title: tr('Історія'), favicon: 'clock', url: 'astra://history' },
  downloads: { title: tr('Завантаження'), favicon: 'download', url: 'astra://downloads' },
  bookmarks: { title: tr('Закладки'), favicon: 'star', url: 'astra://bookmarks' },
  passwords: { title: tr('Паролі'), favicon: 'key', url: 'astra://passwords' },
  notes: { title: tr('Нотатки'), favicon: 'notes', url: 'astra://notes' },
  profile: { title: tr('Керування профілем'), favicon: 'user', url: 'astra://profile' },
  personalization: { title: tr('Персоналізація'), favicon: 'palette', url: 'astra://personalization' },
  extensions: { title: tr('Розширення'), favicon: 'puzzle', url: 'astra://extensions' },
  settings: { title: tr('Налаштування'), favicon: 'settings', url: 'astra://settings' },
  help: { title: tr('Довідка'), favicon: 'help', url: 'astra://help' },
};

/** Внутрішня сторінка за адресою astra://… або `null`, якщо це не вона. */
export function internalPageFor(url: string): InternalPage | null {
  const entry = Object.entries(TAB_PAGES).find(([page, info]) => page !== 'new-tab' && info.url === url);
  return entry ? (entry[0] as InternalPage) : null;
}

/** Гарячі клавіші, що справді працюють; показуються на сторінці довідки. */
export const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly action: string }[] = [
  { keys: ['Ctrl', 'T'], action: tr('Нова вкладка') },
  { keys: ['Ctrl', 'Shift', 'T'], action: tr('Відновити закриту вкладку') },
  { keys: ['Ctrl', 'N'], action: tr('Нове вікно') },
  { keys: ['Ctrl', 'Shift', 'N'], action: tr('Приватне вікно') },
  { keys: ['Ctrl', 'J'], action: tr('Завантаження') },
  { keys: ['Ctrl', 'F'], action: tr('Знайти на сторінці') },
  { keys: ['Ctrl', 'Shift', ']'], action: tr('Картинка в картинці (відео YouTube)') },
  { keys: ['Ctrl', 'Shift', 'S'], action: tr('Скріншот сторінки') },
  { keys: ['Ctrl', '+'], action: tr('Збільшити масштаб (Ctrl + коліщатко вгору)') },
  { keys: ['Ctrl', '−'], action: tr('Зменшити масштаб (Ctrl + коліщатко вниз)') },
  { keys: ['Ctrl', '0'], action: tr('Масштаб 100%') },
  { keys: ['Enter'], action: tr('Наступний збіг у пошуку на сторінці') },
  { keys: ['Shift', 'Enter'], action: tr('Попередній збіг у пошуку на сторінці') },
  { keys: ['Esc'], action: tr('Закрити пошук або меню') },
  { keys: ['Ctrl', 'P'], action: tr('Друк') },
  { keys: ['Ctrl', 'U'], action: tr('Переглянути джерело сторінки') },
  { keys: ['F12'], action: tr('Інструменти розробника (Ctrl + Shift + I)') },
];

const DAY = 24 * 60 * 60 * 1000;

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
    const label =
      time >= startOfToday
        ? translate('Сьогодні')
        : time >= startOfToday - DAY
          ? translate('Вчора')
          : formatDate(time, { day: 'numeric', month: 'long', year: 'numeric' });
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups].map(([label, groupItems]) => ({ label, items: groupItems }));
}

export function formatTime(time: number): string {
  return formatDate(time, { hour: '2-digit', minute: '2-digit' });
}

export function formatSize(bytes: number): string {
  const units = [translate('Б'), translate('КБ'), translate('МБ'), translate('ГБ')];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatNumber(value, { maximumFractionDigits: 1 })} ${units[unit]}`;
}

export function hostname(url: string): string {
  try {
    return new URL(url.replace(/^view-source:/i, '')).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Адреса вкладки сайту: сам сайт (http, https) чи його код (view-source:…, Ctrl+U). */
export function isPageUrl(url: string): boolean {
  return /^(?:view-source:)?https?:/i.test(url);
}

/** Код сторінки сайту — адреса для нової вкладки. */
export function viewSourceUrl(url: string): string {
  return `view-source:${url.replace(/^view-source:/i, '')}`;
}

/** Пошук без урахування регістру по будь-якому з полів. */
export function matchesQuery(query: string, ...fields: (string | undefined)[]): boolean {
  const needle = query.trim().toLocaleLowerCase('uk');
  return !needle || fields.some((field) => field?.toLocaleLowerCase('uk').includes(needle));
}
