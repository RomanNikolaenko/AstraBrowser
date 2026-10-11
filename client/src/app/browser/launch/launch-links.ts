import { Injectable, inject } from '@angular/core';
import { AppOpenEvent, PageViews } from '../page-views/page-views';

/**
 * Посилання з інших програм і повторний запуск браузера (server/src/launch.rs) — з першої миті вікна. Поки браузера
 * у вікні ще немає (сторінка входу), посилання чекають і відкриються, щойно він з'явиться. Повторний запуск без
 * посилань тоді нічого не відкриває: вікно й так вийшло наперед.
 */
@Injectable({ providedIn: 'root' })
export class LaunchLinks {
  private readonly waiting: AppOpenEvent[] = [];
  private handler: ((event: AppOpenEvent) => void) | null = null;

  constructor() {
    const pages = inject(PageViews);
    if (!pages.available) {
      return;
    }
    pages
      .on('app://open', (event) => {
        if (this.handler) {
          this.handler(event);
        } else if (event.urls.length > 0) {
          this.waiting.push(event);
        }
      })
      .catch(() => undefined);
  }

  /** Браузер у вікні: обробляти запити, зокрема ті, що чекали. Повертає відписку. */
  attach(handler: (event: AppOpenEvent) => void): () => void {
    this.handler = handler;
    this.waiting.splice(0).forEach(handler);
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }
}
