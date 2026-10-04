/** Мови перекладу: код Google Перекладача й назва. */
export const TRANSLATE_LANGUAGES = [
  { value: 'uk', label: 'Українська' },
  { value: 'en', label: 'English' },
  { value: 'pl', label: 'Polski' },
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: 'cs', label: 'Čeština' },
  { value: 'tr', label: 'Türkçe' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh-CN', label: '中文（简体）' },
] as const;

const PROXY = '.translate.goog';

/** Сторінка вже відкрита через перекладач Google (адреса на *.translate.goog). */
export function isTranslated(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(PROXY);
  } catch {
    return false;
  }
}

/**
 * Початкова адреса перекладеної сторінки. Google кодує сайт у піддомені: крапки стають «-», а дефіси — «--»
 * (www-example--site-com.translate.goog ← www.example-site.com), а свої параметри додає з префіксом _x_tr_.
 */
export function originalUrl(url: string): string | null {
  try {
    const translated = new URL(url);
    if (!translated.hostname.endsWith(PROXY)) {
      return null;
    }
    const host = translated.hostname
      .slice(0, -PROXY.length)
      .split('--')
      .map((part) => part.replace(/-/g, '.'))
      .join('-');
    const scheme = translated.searchParams.get('_x_tr_sch') === 'http' ? 'http' : 'https';
    const original = new URL(`${scheme}://${host}${translated.pathname}${translated.hash}`);
    for (const [key, value] of translated.searchParams) {
      if (!key.startsWith('_x_tr_')) {
        original.searchParams.append(key, value);
      }
    }
    return original.href;
  } catch {
    return null;
  }
}

/** Сторінка в перекладі Google на мову `language` (уже перекладена — заново, з її початкової адреси). */
export function translatePageUrl(url: string, language: string): string {
  const source = originalUrl(url) ?? url;
  return `https://translate.google.com/translate?sl=auto&tl=${encodeURIComponent(language)}&hl=uk&u=${encodeURIComponent(source)}`;
}

/** Google Перекладач із текстом `text`. */
export function translateTextUrl(text: string, language: string): string {
  return `https://translate.google.com/?sl=auto&tl=${encodeURIComponent(language)}&text=${encodeURIComponent(text)}&op=translate`;
}
