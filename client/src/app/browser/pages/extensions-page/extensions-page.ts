import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UiAccordion } from '../../../shared/ui-accordion/ui-accordion';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { AdBlockStore } from '../../data/adblock';
import { SiteIcon } from '../../site-icon/site-icon';

const updatedFormat = new Intl.DateTimeFormat('uk', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

/** Вбудовані розширення браузера; поки це блокувальник реклами (server/src/adblock.rs). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SiteIcon, UiAccordion, UiIcon],
  selector: 'app-extensions-page',
  styleUrls: ['../internal-page.scss', './extensions-page.scss'],
  templateUrl: './extensions-page.html',
})
export class ExtensionsPage {
  protected readonly adblock = inject(AdBlockStore);

  /** Рядок стану списків фільтрів під описом розширення. */
  protected readonly listsState = computed(() => {
    const status = this.adblock.status();
    if (!status) {
      if (!this.adblock.available) {
        return { text: 'Працює лише в застосунку Astra Browser', error: false };
      }
      return this.adblock.failed()
        ? { text: 'Блокувальник не відповідає — перезапустіть Astra Browser', error: true }
        : { text: 'Завантаження…', error: false };
    }
    if (status.updating) {
      return { text: 'Оновлення списків фільтрів…', error: false };
    }
    if (status.error) {
      return { text: `Не вдалося оновити списки: ${status.error}`, error: true };
    }
    if (status.updatedAt) {
      return { text: `Списки оновлено ${updatedFormat.format(status.updatedAt)}`, error: false };
    }
    return { text: 'Списки фільтрів ще не завантажено', error: false };
  });

  protected setEnabled(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.adblock.setEnabled(input.checked).catch(() => (input.checked = !input.checked));
  }

  protected update(): void {
    void this.adblock.update().catch(() => undefined);
  }

  protected enableSite(site: string): void {
    void this.adblock.setSiteEnabled(site, true).catch(() => undefined);
  }
}
