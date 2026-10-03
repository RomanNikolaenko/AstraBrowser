import { Injectable, signal } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

/** Скільки сайтів пам'ятати: найстаріші записи витісняються. */
const LIMIT = 300;

/** Іконки сайтів (за host), які повідомили самі сторінки через <link rel="icon">. */
@Injectable({ providedIn: 'root' })
export class FaviconStore {
  private readonly icons = storedSignal<Readonly<Record<string, string>>>('astra.favicons', {});
  /** Іконки, що не завантажилися в цьому вікні: замість них — наступний варіант. */
  private readonly broken = signal<ReadonlySet<string>>(new Set());

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

  markBroken(icon: string): void {
    this.broken.update((broken) => new Set(broken).add(icon));
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
