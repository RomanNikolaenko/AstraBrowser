import { Injectable, signal } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { accountSignal } from '../../shared/storage/stored-signal';

/** Скільки сайтів пам'ятати: найстаріші записи витісняються. */
const LIMIT = 300;

/**
 * Іконки сайтів (за host), які повідомили самі сторінки через <link rel="icon">. Сайт, якого тут ще не відкривали і
 * в якого немає /favicon.ico (закладка Supabase, gmail.com), браузер один раз шукає сам (server/src/favicons.rs).
 */
@Injectable({ providedIn: 'root' })
export class FaviconStore {
  private readonly icons = accountSignal<Readonly<Record<string, string>>>('astra.favicons', {});
  /** Іконки, що не завантажилися в цьому вікні: замість них — наступний варіант. */
  private readonly broken = signal<ReadonlySet<string>>(new Set());
  /** Сайти, значок яких уже шукали в цьому вікні: удруге не шукаємо. */
  private readonly searched = new Set<string>();

  /** Іконка сторінки: повідомлена сайтом, інакше /favicon.ico; null — для не-вебових адрес чи якщо жодна не вантажиться. */
  iconFor(url: string): string | null {
    const site = parse(url);
    if (!site) {
      return null;
    }
    const candidates = [this.icons()[site.host], `${site.origin}/favicon.ico`];
    return candidates.find((icon) => icon && !this.broken().has(icon)) ?? null;
  }

  remember(url: string, icon: string): void {
    const site = parse(url);
    if (!site || this.icons()[site.host] === icon) {
      return;
    }
    // Свіжий запис — у кінець, щоб витіснялися ті, що давно не оновлювалися.
    this.icons.update((icons) => {
      const others = Object.entries(icons).filter(([host]) => host !== site.host);
      return Object.fromEntries([...others, [site.host, icon]].slice(-LIMIT));
    });
    this.broken.update((broken) => {
      const next = new Set(broken);
      next.delete(icon);
      return next;
    });
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
    invoke<string | null>('favicon_find', { url: site.href })
      .then((icon) => {
        if (icon) {
          this.remember(url, icon);
        }
      })
      .catch(() => undefined);
  }

  clear(): void {
    this.icons.set({});
  }
}

function parse(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}
