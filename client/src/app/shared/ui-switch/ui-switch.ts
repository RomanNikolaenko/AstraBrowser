import { ChangeDetectionStrategy, Component, booleanAttribute, input, output } from '@angular/core';

/**
 * Перемикач «увімкнено/вимкнено»: справжній checkbox з role="switch", оформлений як повзунок.
 *
 * Керований ззовні: стан — лише з `[checked]`, а клік повідомляє `(checkedChange)` новим значенням. Поки
 * батьківський компонент його не прийняв (скажімо, команда Rust ще виконується чи не вдалася), перемикач лишається
 * як був — і не показує того, чого немає.
 *
 * Перемикається лише кліком по самому перемикачу, а не по всьому рядку налаштування: тож рядок — не <label>, а
 * підпис і пояснення — текст поряд, пов'язаний через `ariaLabelledby` і `ariaDescribedby` (або просто `ariaLabel`).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-switch',
  styleUrl: './ui-switch.scss',
  template: `
    <input
      class="switch"
      type="checkbox"
      role="switch"
      [attr.id]="inputId() || null"
      [attr.name]="inputName() || null"
      [attr.aria-label]="ariaLabel() || null"
      [attr.aria-labelledby]="ariaLabelledby() || null"
      [attr.aria-describedby]="ariaDescribedby() || null"
      [checked]="checked()"
      [disabled]="disabled()"
      (change)="toggle($event)" />
  `,
})
export class UiSwitch {
  readonly checked = input(false, { transform: booleanAttribute });
  readonly disabled = input(false, { transform: booleanAttribute });
  readonly inputId = input<string>();
  readonly inputName = input<string>();
  readonly ariaLabel = input<string>();
  /** id тексту, що називає перемикач (назва рядка налаштування). */
  readonly ariaLabelledby = input<string>();
  /** id тексту, що пояснює перемикач. */
  readonly ariaDescribedby = input<string>();

  readonly checkedChange = output<boolean>();

  protected toggle(event: Event): void {
    const control = event.target as HTMLInputElement;
    const wanted = control.checked;
    // Новий стан покаже [checked], коли його приймуть; до того — той, що є.
    control.checked = this.checked();
    this.checkedChange.emit(wanted);
  }
}
