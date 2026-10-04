import { Injectable, computed } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';
import type { AutoplayRules } from '../page-views/page-views';

/** Що сайту дозволено: усе, лише без звуку чи нічого без дії користувача (як за замовчуванням). */
export type AutoplayChoice = 'allow' | 'block-audio' | 'block';

/**
 * Автовідтворення на сайтах (origin): кому дозволено все, кому — лише без звуку. Решта — «Блокувати аудіо та
 * відео»: відео й аудіо стартують, лише коли користувач сам їх запустить (server/src/audio.rs).
 */
@Injectable({ providedIn: 'root' })
export class AutoplayStore {
  private readonly allowed = accountSignal<readonly string[]>('astra.autoplay.allow', []);
  private readonly audioBlocked = accountSignal<readonly string[]>('astra.autoplay.block-audio', []);

  readonly rules = computed<AutoplayRules>(() => ({ allow: this.allowed(), blockAudio: this.audioBlocked() }));

  choiceFor(origin: string): AutoplayChoice {
    return this.allowed().includes(origin) ? 'allow' : this.audioBlocked().includes(origin) ? 'block-audio' : 'block';
  }

  /** Усім сайтам — знову як за замовчуванням («Налаштування сайтів» в очищенні даних). */
  reset(): void {
    this.allowed.set([]);
    this.audioBlocked.set([]);
  }

  setChoice(origin: string, choice: AutoplayChoice): void {
    const set = (list: readonly string[], included: boolean) => [
      ...list.filter((item) => item !== origin),
      ...(included ? [origin] : []),
    ];
    this.allowed.update((list) => set(list, choice === 'allow'));
    this.audioBlocked.update((list) => set(list, choice === 'block-audio'));
  }
}
