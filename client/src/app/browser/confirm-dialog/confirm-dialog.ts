import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  booleanAttribute,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';

let nextId = 0;

/**
 * Спливне вікно підтвердження перед дією, яку не скасувати (очистити історію тощо).
 * Справжній модальний `<dialog>`: затемнює все довкола, тримає фокус у собі, закривається Esc
 * чи кліком повз вікно (closedby="any"). Фокус спершу на «Скасувати» — випадковий Enter нічого не зітре.
 *
 * Відкривається з коду: `<app-confirm-dialog #clear … (confirmed)="clear()" />` і `clear.show()`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-confirm-dialog',
  styleUrl: './confirm-dialog.scss',
  templateUrl: './confirm-dialog.html',
})
export class ConfirmDialog {
  readonly heading = input.required<string>();
  readonly message = input('');
  readonly confirmLabel = input('Підтвердити');
  readonly cancelLabel = input('Скасувати');
  /** Незворотна дія: червона кнопка й значок-попередження. */
  readonly danger = input(false, { transform: booleanAttribute });

  readonly confirmed = output<void>();

  readonly isOpen = signal(false);

  protected readonly headingId = `confirm-dialog-${nextId++}`;
  protected readonly messageId = `${this.headingId}-message`;

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  show(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
    this.isOpen.set(true);
  }

  hide(): void {
    this.dialog().nativeElement.close?.();
    this.isOpen.set(false);
  }

  protected confirm(): void {
    this.hide();
    this.confirmed.emit();
  }

  /** Закрили не кнопками — Esc чи кліком повз вікно. */
  protected onClose(): void {
    this.isOpen.set(false);
  }
}
