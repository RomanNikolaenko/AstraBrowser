import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { PageFailure } from '../page-views/page-views';
import { TranslatePipe } from '../../shared/i18n/i18n';

/** Замість сторінки, процес якої впав чи завис: пояснення й «Перезавантажити» (а для завислої — ще «Чекати»). */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-page-crashed',
  styleUrl: './page-crashed.scss',
  templateUrl: './page-crashed.html',
})
export class PageCrashed {
  readonly failure = input.required<PageFailure>();
  /** «Чекати» — зависла сторінка ще може отямитися. */
  readonly wait = output<void>();
  readonly reload = output<void>();
}
