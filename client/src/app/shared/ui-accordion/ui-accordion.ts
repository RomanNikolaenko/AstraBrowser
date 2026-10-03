import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';
import { UiIcon } from '../ui-icon/ui-icon';

let nextId = 0;

/**
 * Акордеон: заголовок-кнопка, що кліком розгортає й згортає вміст (між тегами).
 * Висота анімується переходом grid-template-rows від 0fr до 1fr — без JS і без фіксованої висоти.
 * Згорнутий вміст неактивний (inert): його не видно ні клавіатурі, ні екранному читачу.
 * Кольори й відступи — змінні `--accordion-*` на `<app-accordion>`.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-accordion',
  styleUrl: './ui-accordion.scss',
  templateUrl: './ui-accordion.html',
  host: {
    '[class.ui-accordion--open]': 'open()',
  },
})
export class UiAccordion {
  readonly heading = input.required<string>();
  /** Невелика позначка біля заголовка — скажімо, скільки всередині пунктів. */
  readonly badge = input<string | number>();
  readonly open = model(false);

  protected readonly triggerId = `ui-accordion-${nextId++}`;
  protected readonly panelId = `${this.triggerId}-panel`;

  protected toggle(): void {
    this.open.update((open) => !open);
  }
}
