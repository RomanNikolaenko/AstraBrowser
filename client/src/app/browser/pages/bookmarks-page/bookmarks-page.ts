import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { FormField, normalizeUrl, required, urlFormat, validateFields } from '../../../shared/form-field/form-field';
import { MiddleClick } from '../../../shared/middle-click/middle-click';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { UiInput } from '../../../shared/ui-input/ui-input';
import { BookmarksStore } from '../../data/bookmarks';
import { SiteIcon } from '../../site-icon/site-icon';
import { hostname, internalPageFor, matchesQuery } from '../internal-pages';
import { tr, TranslatePipe } from '../../../shared/i18n/i18n';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, MiddleClick, SiteIcon, UiIcon, UiInput],
  selector: 'app-bookmarks-page',
  styleUrls: ['../internal-page.scss', './bookmarks-page.scss'],
  templateUrl: './bookmarks-page.html',
})
export class BookmarksPage {
  /** Клік по закладці — сторінка в цій вкладці, коліщатком — у новій. */
  readonly openUrl = output<string>();
  readonly openUrlInNewTab = output<string>();

  protected readonly bookmarks = inject(BookmarksStore);

  protected readonly query = signal('');
  protected readonly adding = signal(false);

  protected readonly title = new FormField([required(tr('Введіть назву'))]);
  protected readonly url = new FormField([required(tr('Введіть адресу')), urlFormat(tr('Некоректна адреса сайту'))]);

  protected readonly visible = computed(() => {
    const query = this.query();
    return this.bookmarks.entries().filter((bookmark) => matchesQuery(query, bookmark.title, bookmark.url));
  });

  /** Для внутрішньої сторінки — адреса astra://…, для сайту — домен. */
  protected describe(url: string): string {
    return internalPageFor(url) ? url : hostname(url);
  }

  protected startAdding(): void {
    this.adding.set(true);
  }

  protected save(event: Event): void {
    event.preventDefault();
    const url = normalizeUrl(this.url.value());
    if (!validateFields([this.title, this.url]) || !url) {
      return;
    }

    this.bookmarks.add(this.title.value().trim(), url);
    this.cancel();
  }

  protected cancel(): void {
    for (const field of [this.title, this.url]) {
      field.value.set('');
      field.touched.set(false);
    }
    this.adding.set(false);
  }
}
