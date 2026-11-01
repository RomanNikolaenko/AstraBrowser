import { Injectable, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { accountSignal } from '../../shared/storage/stored-signal';

/** Скільки сайтів пам'ятати: найстаріші записи витісняються. */
const LIMIT = 300;

/**
 * Іконки сайтів (за host), які повідомили самі сторінки через <link rel="icon">. Сайт, якого тут ще не відкривали і
 * в якого немає /favicon.ico (закладка Supabase, gmail.com), браузер один раз шукає сам (server/src/favicons.rs).
 *
 * У Windows сторінка повідомляє адресу іконки й ту саму іконку картинкою, як її завантажила сама. За адресою інтерфейс
 * отримує її не завжди — сайти за перевіркою Cloudflare (hltv.org) часом відповідають йому 403, — і тоді береться
 * картинка. Але першою — адреса: WebView2 дає картинку лише 16×16, а за адресою буває 32×32, чіткіше на екранах зі
 * збільшенням.
 */
@Injectable({ providedIn: 'root' })
export class FaviconStore {
  private readonly icons = accountSignal<Readonly<Record<string, string>>>('astra.favicons', {});
  /** Ті самі іконки картинками (data:), як їх завантажили сторінки, — запасні до адрес з `icons`. */
  private readonly images = accountSignal<Readonly<Record<string, string>>>('astra.favicon-images', {});
  /** Іконки, що не завантажилися в цьому вікні: замість них — наступний варіант. */
  private readonly broken = signal<ReadonlySet<string>>(new Set());
  /** Сайти, значок яких уже шукали в цьому вікні: удруге не шукаємо. */
  private readonly searched = new Set<string>();

  /**
   * Іконка сторінки: повідомлена сайтом (адресою, а не вантажиться — картинкою), інакше /favicon.ico; null — для
   * не-вебових адрес чи якщо жодна не вантажиться.
   */
  iconFor(url: string): string | null {
    const site = parse(url);
    if (!site) {
      return null;
    }
    const candidates = [this.icons()[site.host], this.images()[site.host], `${site.origin}/favicon.ico`];
    return candidates.find((icon) => icon && !this.broken().has(icon)) ?? null;
  }

  /** `image` — та сама іконка картинкою, як її завантажила сторінка (лише у Windows). */
  remember(url: string, icon: string, image?: string | null): void {
    const site = parse(url);
    if (!site) {
      return;
    }
    // Те саме, що вже знаємо (сторінка повідомляє значок на кожному переході), — нічого не міняємо: інакше адреса, що
    // не вантажиться, щоразу пробувалася б наново, і значок блимав би.
    const freshIcon = this.icons()[site.host] !== icon;
    const freshImage = !!image && this.images()[site.host] !== image;
    if (freshIcon) {
      this.icons.update((icons) => withFresh(icons, site.host, icon));
    }
    if (image && freshImage) {
      this.images.update((images) => withFresh(images, site.host, image));
    }
    if (freshIcon || freshImage) {
      this.broken.update(
        (broken) => new Set([...broken].filter((known) => !(freshIcon && known === icon) && !(freshImage && known === image)))
      );
    }
  }

  /** Іконка `icon` адреси `url` не завантажилася; якщо інших варіантів немає — шукаємо значок сайту. */
  markBroken(icon: string, url?: string): void {
    this.broken.update((broken) => new Set(broken).add(icon));
    if (url && !this.iconFor(url)) {
      this.discover(url);
    }
  }

  private discover(url: string): void {
    const site = parse(url);
    if (!site || !isTauri() || this.searched.has(site.host)) {
      return;
    }
    this.searched.add(site.host);
    commands
      .faviconFind(site.href)
      .then((icon) => {
        if (icon) {
          this.remember(url, icon);
        }
      })
      .catch(() => undefined);
  }

  clear(): void {
    this.icons.set({});
    this.images.set({});
  }
}

/** Запис сайту `host` — свіжий, у кінець, щоб витіснялися ті, що давно не оновлювалися. */
function withFresh(entries: Readonly<Record<string, string>>, host: string, value: string): Record<string, string> {
  const others = Object.entries(entries).filter(([key]) => key !== host);
  return Object.fromEntries([...others, [host, value]].slice(-LIMIT));
}

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}
