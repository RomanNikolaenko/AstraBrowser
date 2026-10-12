import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { LanguageSwitch } from '../language-switch/language-switch';

/**
 * Каркас сторінок входу: вгорі праворуч перемикач мови, ліворуч логотип, заголовок і переваги, праворуч панель —
 * її вміст (вкладки, форма) передає сторінка між тегами.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LanguageSwitch, TranslatePipe, UiIcon],
  selector: 'app-auth-layout',
  styleUrl: '../auth.scss',
  templateUrl: './auth-layout.html',
})
export class AuthLayout {
  /** Рядки заголовка. */
  readonly heading = input.required<readonly string[]>();
  readonly description = input.required<string>();
}
