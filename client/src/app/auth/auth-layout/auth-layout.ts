import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';

/**
 * Каркас сторінок входу: ліворуч логотип, заголовок і переваги, праворуч панель — її вміст (вкладки, форма)
 * передає сторінка між тегами.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-auth-layout',
  styleUrl: '../auth.scss',
  templateUrl: './auth-layout.html',
})
export class AuthLayout {
  /** Рядки заголовка. */
  readonly heading = input.required<readonly string[]>();
  readonly description = input.required<string>();
}
