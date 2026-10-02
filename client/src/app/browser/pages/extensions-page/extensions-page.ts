import { ChangeDetectionStrategy, Component } from '@angular/core';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';

/** Системи розширень ще немає — сторінка чесно про це каже. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-extensions-page',
  styleUrls: ['../internal-page.scss'],
  template: `
    <section class="page">
      <header class="page__header">
        <h1 class="page__title">Розширення</h1>
      </header>
      <div class="page__empty">
        <span class="page__empty-icon"><app-icon icon="puzzle" /></span>
        <h2 class="page__empty-title">Розширень поки немає</h2>
        <p>Підтримка розширень з'явиться в одній із наступних версій Astra Browser.</p>
      </div>
    </section>
  `,
})
export class ExtensionsPage {}
