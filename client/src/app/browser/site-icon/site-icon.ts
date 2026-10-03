import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { FaviconStore } from '../data/favicons';
import { TAB_PAGES, internalPageFor } from '../pages/internal-pages';

/** Значок адреси: власна іконка внутрішньої сторінки, іконка сайту або глобус, якщо її немає. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-site-icon',
  styleUrl: './site-icon.scss',
  templateUrl: './site-icon.html',
})
export class SiteIcon {
  readonly url = input.required<string>();
  /** Розмір на сторінці в px — для width/height картинки. */
  readonly size = input.required<number>();

  protected readonly favicons = inject(FaviconStore);

  protected readonly pageIcon = computed(() => {
    const page = internalPageFor(this.url());
    return page ? TAB_PAGES[page].favicon : null;
  });
  protected readonly siteIcon = computed(() => this.favicons.iconFor(this.url()));
}
