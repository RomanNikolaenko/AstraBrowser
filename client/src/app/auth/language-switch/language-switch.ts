import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { I18n, Language, LANGUAGE_CODES, LANGUAGE_NAMES, TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';

/**
 * Перемикач мови на сторінках входу: «УКР | ENG». Вибір запам'ятовується так само, як у налаштуваннях браузера
 * (там можна повернути «Як у системі»).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-language-switch',
  styleUrl: './language-switch.scss',
  templateUrl: './language-switch.html',
})
export class LanguageSwitch {
  protected readonly i18n = inject(I18n);
  protected readonly languages: readonly Language[] = ['uk', 'en'];
  protected readonly names = LANGUAGE_NAMES;
  protected readonly codes = LANGUAGE_CODES;
}
