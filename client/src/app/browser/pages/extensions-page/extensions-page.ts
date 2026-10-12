import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { UiSwitch } from '../../../shared/ui-switch/ui-switch';
import { UiAccordion } from '../../../shared/ui-accordion/ui-accordion';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { AdBlockStore } from '../../data/adblock';
import { SiteIcon } from '../../site-icon/site-icon';
import { formatDate, translate, TranslatePipe } from '../../../shared/i18n/i18n';

/** Вбудовані розширення браузера; поки це блокувальник реклами (server/src/adblock.rs). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, SiteIcon, UiAccordion, UiIcon, UiSwitch],
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
        return { text: translate('Працює лише в застосунку Astra Browser'), error: false };
      }
      return this.adblock.failed()
        ? { text: translate('Блокувальник не відповідає — перезапустіть Astra Browser'), error: true }
        : { text: translate('Завантаження…'), error: false };
    }
    if (status.updating) {
      return { text: translate('Оновлення списків фільтрів…'), error: false };
    }
    if (status.error) {
      return { text: translate('Не вдалося оновити списки: {0}', [status.error]), error: true };
    }
    if (status.updatedAt) {
      const updated = formatDate(status.updatedAt, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      return { text: translate('Списки оновлено {0}', [updated]), error: false };
    }
    return { text: translate('Списки фільтрів ще не завантажено'), error: false };
  });

  protected setEnabled(enabled: boolean): void {
    void this.adblock.setEnabled(enabled).catch(() => undefined);
  }

  protected update(): void {
    void this.adblock.update().catch(() => undefined);
  }

  protected enableSite(site: string): void {
    void this.adblock.setSiteEnabled(site, true).catch(() => undefined);
  }
}
