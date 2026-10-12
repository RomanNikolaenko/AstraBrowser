import { Injectable } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';

/**
 * Мова перекладу з «Перекладача»: на неї перекладаються сторінки й текст. Виділене на сайті перекладається у своєму
 * віконці (server/src/selection-translate.js) — там мову вибирають окремо, типово це мова інтерфейсу.
 */
@Injectable({ providedIn: 'root' })
export class TranslateLanguageStore {
  readonly language = accountSignal<string>('astra.translate.language', 'uk');
}
