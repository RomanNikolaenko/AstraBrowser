import { DestroyRef, Injectable, Pipe, PipeTransform, computed, effect, inject } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { storedSignal } from '../storage/stored-signal';
import { EN } from './en';

/** Мови інтерфейсу. */
export type Language = 'uk' | 'en';
/** Вибір у налаштуваннях: «як у системі» чи певна мова. */
export type LanguagePreference = 'system' | Language;

/** Назви мов у перемикачах — кожна своєю мовою, щоб її впізнав і той, хто не читає поточною. */
export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { uk: 'Українська', en: 'English' };
/** Короткі назви для компактного перемикача (сторінки входу). */
export const LANGUAGE_CODES: Readonly<Record<Language, string>> = { uk: 'УКР', en: 'ENG' };

/**
 * Мова Windows: англійська — англійською, будь-яка інша — українською. WebView2 бере navigator.languages з мови
 * Windows. Поза застосунком (тести, ng serve) — українська.
 */
export function systemLanguage(languages: readonly string[] = isTauri() ? navigator.languages : []): Language {
  return languages[0]?.toLowerCase().startsWith('en') ? 'en' : 'uk';
}

/**
 * Позначка українського тексту, що лежить у даних (пункти меню, підписи): він перекладається там, де його показують
 * (`| t`), а перевірка словника (i18n.spec.ts) знаходить його за цією позначкою.
 */
export function tr(text: string): string {
  return text;
}

/** Ключ словника: текст без зайвих пробілів і переносів (у шаблонах він часто розбитий на рядки). */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const PLURAL = { uk: new Intl.PluralRules('uk'), en: new Intl.PluralRules('en') };
const LOCALE: Readonly<Record<Language, string>> = { uk: 'uk-UA', en: 'en-US' };
const keys = new Map<string, string>();
const formats = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

function translateTo(language: Language, text: string, params: readonly unknown[]): string {
  let key = keys.get(text);
  if (key === undefined) {
    key = normalize(text);
    keys.set(text, key);
  }
  let translated = language === 'en' ? (EN[key] ?? key) : key;
  // Пробіли на краях — частина склеювання ('Видалити ' + назва): перекладається лише сам текст.
  if (translated && text !== key) {
    translated = (/^\s/.test(text) ? ' ' : '') + translated + (/\s$/.test(text) ? ' ' : '');
  }
  return params.length ? translated.replace(/\{(\d+)\}/g, (match, index: string) => String(params[+index] ?? '')) : translated;
}

function pluralIn(language: Language, count: number, uk: readonly string[], en: readonly string[]): string {
  let form: string;
  if (language === 'en') {
    form = PLURAL.en.select(count) === 'one' ? en[0] : en[1];
  } else {
    const rule = PLURAL.uk.select(count);
    form = rule === 'one' ? uk[0] : rule === 'many' ? uk[2] : uk[1];
  }
  return form.replace('{0}', String(count));
}

/** Форматувальник Intl для мови й параметрів — один на всі виклики. */
function formatter<T extends Intl.DateTimeFormat | Intl.NumberFormat>(
  kind: string,
  language: Language,
  options: object,
  create: (locale: string) => T
): T {
  const key = `${kind}|${language}|${JSON.stringify(options)}`;
  let found = formats.get(key) as T | undefined;
  if (!found) {
    found = create(LOCALE[language]);
    formats.set(key, found);
  }
  return found;
}

/** Сервіс мови, щойно його створено, — для функцій поза компонентами. */
let active: I18n | null = null;

/** Мова інтерфейсу для функцій поза компонентами; до створення I18n (окремі тести функцій) — українська. */
function current(): Language {
  return active?.language() ?? 'uk';
}

/**
 * Мова інтерфейсу. Ключ перекладу — сам український текст: українською він показується як є, англійською —
 * з EN (en.ts); якщо перекладу немає, лишається українським. `{0}`, `{1}`… — значення з `params`.
 * Мова — на цьому комп'ютері (не синхронізується): типово як у Windows.
 */
@Injectable({ providedIn: 'root' })
export class I18n {
  readonly preference = storedSignal<LanguagePreference>('astra.settings.language', 'system');
  /** Мова Windows — для «Як у системі». */
  readonly system = systemLanguage();
  readonly language = computed<Language>(() => {
    const preference = this.preference();
    return preference === 'system' ? this.system : preference;
  });

  constructor() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- один сервіс мови на вікно, для функцій поза компонентами
    active = this;
    // Знищений сервіс (між тестами) більше не задає мову: функції поза компонентами повертаються до української.
    inject(DestroyRef).onDestroy(() => {
      if (active === this) {
        active = null;
      }
    });
    effect(() => {
      const language = this.language();
      document.documentElement.lang = language;
      // Повідомлення Rust (помилки, контекстне меню сайтів, вікна вибору файлів) — тією ж мовою.
      if (isTauri()) {
        commands.appSetLanguage(language).catch(() => undefined);
      }
    });
  }

  t(text: string, params: readonly unknown[] = []): string {
    return translateTo(this.language(), text, params);
  }
}

/** Текст мовою інтерфейсу поза шаблонами: `translate('Видалено {0}', [назва])`. */
export function translate(text: string, params: readonly unknown[] = []): string {
  return translateTo(current(), text, params);
}

/**
 * Число з іменником: українською — три форми (один файл, два файли, п'ять файлів), англійською — дві. `{0}` у
 * формі — саме число.
 */
export function plural(
  count: number,
  uk: readonly [one: string, few: string, many: string],
  en: readonly [one: string, other: string]
): string {
  return pluralIn(current(), count, uk, en);
}

/** Дата й час мовою інтерфейсу. */
export function formatDate(value: number | Date, options: Intl.DateTimeFormatOptions): string {
  return formatter('date', current(), options, (locale) => new Intl.DateTimeFormat(locale, options)).format(value);
}

/** Число мовою інтерфейсу (роздільники). */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return formatter('number', current(), options, (locale) => new Intl.NumberFormat(locale, options)).format(value);
}

/** `{{ 'Текст' | t }}`, `{{ 'Видалено {0}' | t: [count] }}` — переклад у шаблоні; стежить за зміною мови. */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(I18n);

  /** Не рядок (число в значку тощо) — показується як є. */
  transform(text: unknown, params?: readonly unknown[]): string {
    if (text == null) {
      return '';
    }
    return typeof text === 'string' ? this.i18n.t(text, params) : String(text);
  }
}
