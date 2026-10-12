import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { I18n, TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { LegalBlock, LegalKind, legalDocument } from '../legal-document';

let nextId = 0;

/**
 * Умови користування чи політика конфіденційності — модальним `<dialog>` поверх сторінки (реєстрації, довідки),
 * тож уведене у форму не губиться. Мовою інтерфейсу; закривається хрестиком, Esc чи кліком повз вікно.
 *
 * `<app-legal-dialog #legal />` і `legal.show('terms')`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-legal-dialog',
  styleUrl: './legal-dialog.scss',
  templateUrl: './legal-dialog.html',
})
export class LegalDialog {
  protected readonly i18n = inject(I18n);
  private readonly kind = signal<LegalKind>('terms');
  protected readonly document = computed(() => legalDocument(this.kind(), this.i18n.language()));
  /** Вступ — розділ без заголовка. */
  protected readonly sections = computed(() => [{ heading: '', blocks: this.document().intro }, ...this.document().sections]);
  protected readonly headingId = `legal-dialog-${nextId++}`;

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');

  show(kind: LegalKind): void {
    this.kind.set(kind);
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
    this.body().nativeElement.scrollTop = 0;
  }

  hide(): void {
    this.dialog().nativeElement.close?.();
  }

  protected isList(block: LegalBlock): block is readonly string[] {
    return Array.isArray(block);
  }
}
