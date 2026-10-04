import { DestroyRef, Injectable, computed, effect, inject, untracked } from '@angular/core';
import { AuthStore } from '../../shared/auth/auth';
import { accountSignal } from '../../shared/storage/stored-signal';

/** Колір аватара з ініціалами. */
export type AvatarColor = 'blue' | 'violet' | 'pink' | 'orange' | 'green' | 'teal' | 'slate';

export const AVATAR_COLORS: readonly { readonly value: AvatarColor; readonly label: string; readonly background: string }[] = [
  { value: 'blue', label: 'Синій', background: 'linear-gradient(135deg, #3b82f6, #6366f1)' },
  { value: 'violet', label: 'Фіолетовий', background: 'linear-gradient(135deg, #8b5cf6, #c026d3)' },
  { value: 'pink', label: 'Рожевий', background: 'linear-gradient(135deg, #ec4899, #f43f5e)' },
  { value: 'orange', label: 'Помаранчевий', background: 'linear-gradient(135deg, #f97316, #f59e0b)' },
  { value: 'green', label: 'Зелений', background: 'linear-gradient(135deg, #10b981, #65a30d)' },
  { value: 'teal', label: 'Бірюзовий', background: 'linear-gradient(135deg, #06b6d4, #0d9488)' },
  { value: 'slate', label: 'Сірий', background: 'linear-gradient(135deg, #64748b, #334155)' },
];

/** Ім'я, коли його ще не вказали. */
export const DEFAULT_PROFILE_NAME = 'Користувач';

/** Ініціали для аватара: перші літери двох перших слів («Роман Ніколаєнко» → «РН»). */
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]?.toLocaleUpperCase('uk') ?? '')
    .join('');
}

/** Через скільки мс після останньої зміни ім'я йде в обліковий запис. */
const NAME_SAVE_DELAY = 800;

/**
 * Профіль облікового запису: ім'я й аватар (колір з ініціалами чи фото). Ім'я живе в обліковому записі Supabase
 * (його видно на всіх комп'ютерах), колір і фото — у даних облікового запису, що синхронізуються (browser/sync).
 */
@Injectable({ providedIn: 'root' })
export class ProfileStore {
  readonly name = accountSignal('astra.profile.name', '');
  readonly color = accountSignal<AvatarColor>('astra.profile.color', 'blue');
  /** Фото (JPEG data: URL, зменшене до 256×256); порожньо — ініціали. */
  readonly photo = accountSignal('astra.profile.photo', '');

  readonly displayName = computed(() => this.name().trim() || DEFAULT_PROFILE_NAME);
  /** Порожньо, поки імені немає — тоді на аватарі значок людини. */
  readonly initials = computed(() => initialsOf(this.name()));
  readonly background = computed(
    () => (AVATAR_COLORS.find((color) => color.value === this.color()) ?? AVATAR_COLORS[0]).background
  );

  private readonly auth = inject(AuthStore);
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.saveTimer));
    // Ім'я з облікового запису: при вході й щоразу, як його змінили (тут чи на іншому комп'ютері).
    effect(() => {
      const name = this.auth.user()?.name;
      if (name) {
        untracked(() => this.name.set(name));
      }
    });
  }

  /** Нове ім'я: одразу тут, а в обліковий запис — щойно перестали друкувати. */
  rename(name: string): void {
    this.name.set(name);
    clearTimeout(this.saveTimer);
    if (!this.auth.available || !this.auth.user()) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      const trimmed = name.trim();
      if (trimmed && trimmed !== this.auth.user()?.name) {
        // Без інтернету ім'я лишається тут; в обліковий запис піде з наступною зміною.
        this.auth.updateName(trimmed).catch(() => undefined);
      }
    }, NAME_SAVE_DELAY);
  }
}
