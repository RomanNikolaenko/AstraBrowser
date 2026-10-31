import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input } from '@angular/core';
import { ICONS } from './icons';

/** Невідомі назви, про які вже повідомлено, — щоб не засмічувати журнал. */
const reported = new Set<string>();

/** Розмітка іконки з src/assets/icons за назвою файлу; невідома — порожньо (і помилка в журналі). */
export function iconMarkup(name: string | undefined): string {
  if (!name) {
    return '';
  }
  const svg = ICONS[name];
  if (svg === undefined && !reported.has(name)) {
    reported.add(name);
    console.error(`Unknown icon: ${name}`);
  }
  return svg ?? '';
}

/**
 * Іконка `<app-icon icon="назва" />`. Іконки вбудовані в збірку (icons.ts, pnpm run icons), тож малюються разом з
 * усім іншим — без окремого запиту на кожну й без миготіння під час запуску.
 */
@Component({
  selector: 'app-icon',
  template: '',
  styleUrl: './ui-icon.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
  },
})
export class UiIcon {
  readonly icon = input<string>();

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => {
      this.el.nativeElement.innerHTML = iconMarkup(this.icon());
    });
  }
}
