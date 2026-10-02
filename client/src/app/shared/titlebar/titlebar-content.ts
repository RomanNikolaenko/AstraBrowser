import { DestroyRef, Directive, Injectable, TemplateRef, inject, signal } from '@angular/core';

/** Вміст, який поточний екран показує в спільному заголовку вікна. */
@Injectable({ providedIn: 'root' })
export class TitlebarSlot {
  private readonly template = signal<TemplateRef<unknown> | null>(null);

  readonly content = this.template.asReadonly();

  attach(template: TemplateRef<unknown>): void {
    this.template.set(template);
  }

  detach(template: TemplateRef<unknown>): void {
    // Новий екран міг під'єднати свій вміст раніше, ніж знищився попередній.
    if (this.template() === template) {
      this.template.set(null);
    }
  }
}

/**
 * Передає шаблон у заголовок вікна, поки екран відкритий:
 * `<ng-template appTitlebarContent>…</ng-template>`.
 * Шаблон лишається частиною екрана: його прив'язки й стилі — від компонента, де він оголошений.
 */
@Directive({ selector: 'ng-template[appTitlebarContent]' })
export class TitlebarContent {
  constructor() {
    const template = inject(TemplateRef);
    const slot = inject(TitlebarSlot);
    slot.attach(template);
    inject(DestroyRef).onDestroy(() => slot.detach(template));
  }
}
