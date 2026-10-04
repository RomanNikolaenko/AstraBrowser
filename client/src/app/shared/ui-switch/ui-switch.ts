import { ChangeDetectionStrategy, Component, booleanAttribute, input, output } from '@angular/core';

/**
 * Перемикач «увімкнено/вимкнено»: справжній checkbox з role="switch", оформлений як повзунок.
 *
 * Керований ззовні: стан — лише з `[checked]`, а клік повідомляє `(checkedChange)` новим значенням. Поки
 * батьківський компонент його не прийняв (скажімо, команда Rust ще виконується чи не вдалася), перемикач лишається
 * як був — і не показує того, чого немає. Підпис — <label for="inputId"> поряд чи `ariaLabel`.
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

  readonly checkedChange = output<boolean>();

  protected toggle(event: Event): void {
    const control = event.target as HTMLInputElement;
    const wanted = control.checked;
    // Новий стан покаже [checked], коли його приймуть; до того — той, що є.
    control.checked = this.checked();
    this.checkedChange.emit(wanted);
  }
}
