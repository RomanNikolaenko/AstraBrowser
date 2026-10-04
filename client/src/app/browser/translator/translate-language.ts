import { Injectable, effect } from '@angular/core';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { accountSignal } from '../../shared/storage/stored-signal';

/**
 * Мова перекладу з «Перекладача»: на неї перекладаються сторінки й текст, а ще виділене на сайтах (значок біля
 * виділення — server/src/translate.rs), тож браузер отримує її щоразу, як вона змінюється.
 */
@Injectable({ providedIn: 'root' })
export class TranslateLanguageStore {
  readonly language = accountSignal<string>('astra.translate.language', 'uk');

  constructor() {
    if (isTauri()) {
      effect(() => {
        const language = this.language();
        invoke('translate_set_language', { language }).catch(() => undefined);
      });
    }
  }
}
