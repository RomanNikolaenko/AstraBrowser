import { Injectable, effect } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
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
        commands.translateSetLanguage(language).catch(() => undefined);
      });
    }
  }
}
