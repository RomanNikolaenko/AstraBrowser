import { Injectable } from '@angular/core';
import { storedSignal } from '../../shared/storage/stored-signal';

/**
 * Сайти (origin), яким заборонено автовідтворення зі звуком — без звуку можна («Блокувати аудіо»).
 * Повну заборону («Блокувати аудіо та відео») зберігає сам WebView2 у профілі.
 */
@Injectable({ providedIn: 'root' })
export class AutoplayStore {
  private readonly origins = storedSignal<readonly string[]>('astra.autoplay.block-audio', []);

  readonly blockAudio = this.origins.asReadonly();

  blocksAudio(origin: string): boolean {
    return this.origins().includes(origin);
  }

  setBlockAudio(origin: string, blocked: boolean): void {
    this.origins.update((origins) => {
      const others = origins.filter((item) => item !== origin);
      return blocked ? [...others, origin] : others;
    });
  }
}
