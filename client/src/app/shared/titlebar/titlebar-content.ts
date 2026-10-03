import { DestroyRef, Directive, Injectable, TemplateRef, computed, inject, output, signal } from '@angular/core';

/** Вміст, який поточний екран показує в спільному заголовку вікна. */
@Injectable({ providedIn: 'root' })
export class TitlebarSlot {
  private readonly current = signal<TitlebarContent | null>(null);

  readonly content = computed(() => this.current()?.template ?? null);

  attach(content: TitlebarContent): void {
    this.current.set(content);
  }

  detach(content: TitlebarContent): void {
    // Новий екран міг під'єднати свій вміст раніше, ніж знищився попередній.
    if (this.current() === content) {
      this.current.set(null);
    }
  }

  /** Передає екрану клік коліщатком по вільному місцю заголовка. */
  spacerMiddleClick(): void {
    this.current()?.spacerMiddleClick.emit();
  }
}

/**
 * Передає шаблон у заголовок вікна, поки екран відкритий:
 * `<ng-template appTitlebarContent (spacerMiddleClick)="…">…</ng-template>`.
 * Шаблон лишається частиною екрана: його прив'язки й стилі — від компонента, де він оголошений.
 */
@Directive({ selector: 'ng-template[appTitlebarContent]' })
export class TitlebarContent {
  readonly template = inject(TemplateRef);

  /** Клік коліщатком миші по вільному місцю заголовка (titlebar__spacer). */
  readonly spacerMiddleClick = output<void>();

  constructor() {
    const slot = inject(TitlebarSlot);
    slot.attach(this);
    inject(DestroyRef).onDestroy(() => slot.detach(this));
  }
}
