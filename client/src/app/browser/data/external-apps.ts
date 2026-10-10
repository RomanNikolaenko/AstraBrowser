import { Injectable, signal } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';

/** Сайт просить відкрити посилання програмою (server/src/external.rs): mailto:, tel:, magnet:… */
export interface ExternalLinkRequest {
  readonly id: number;
  readonly url: string;
  /** Схема без двокрапки: mailto, tel… */
  readonly scheme: string;
  /** Сайт, з якого посилання (origin); порожній — невідомо звідки. */
  readonly origin: string;
  /** Програма Windows, що його відкриє. */
  readonly app: string;
}

let nextId = 1;

/** Схема посилання без двокрапки, у нижньому регістрі; null — не посилання. */
export function schemeOf(url: string): string | null {
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(url.trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Посилання на програми: які сайти можуть відкривати які з них без запитання (дані облікового запису) і черга
 * запитань «Відкрити програму?», яку показує ExternalPrompt.
 */
@Injectable({ providedIn: 'root' })
export class ExternalAppsStore {
  /** «origin схема» — що сайтові дозволено відкривати без запитання. */
  private readonly allowed = accountSignal<readonly string[]>('astra.external.allowed', []);
  readonly prompts = signal<readonly ExternalLinkRequest[]>([]);

  isAllowed(origin: string, scheme: string): boolean {
    return !!origin && this.allowed().includes(`${origin} ${scheme}`);
  }

  allow(origin: string, scheme: string): void {
    const entry = `${origin} ${scheme}`;
    if (origin && !this.allowed().includes(entry)) {
      this.allowed.update((list) => [...list, entry]);
    }
  }

  ask(url: string, origin: string, app: string): void {
    const scheme = schemeOf(url);
    // Те саме посилання вже чекає відповіді (сайт натискає кілька разів) — вдруге не питаємо.
    if (scheme && !this.prompts().some((request) => request.url === url && request.origin === origin)) {
      this.prompts.update((list) => [...list, { id: nextId++, url, scheme, origin, app }]);
    }
  }

  answer(id: number): void {
    this.prompts.update((list) => list.filter((request) => request.id !== id));
  }
}
