import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiSelect } from '../../shared/ui-select/ui-select';
import { hostname } from '../pages/internal-pages';
import { Popover } from '../popover/popover';
import { TranslateLanguageStore } from './translate-language';
import { TRANSLATE_LANGUAGES, isTranslated, originalUrl, translatePageUrl, translateTextUrl } from './translate-urls';
import { TranslatePipe } from '../../shared/i18n/i18n';

/**
 * Перекладач (з «Інструментів»): поточна сторінка — через Google Перекладач (у тій самій вкладці, «Показати оригінал»
 * повертає її), а довільний текст — у Google Перекладачі в новій вкладці. Мова перекладу запам'ятовується
 * (TranslateLanguageStore) — на неї ж перекладається виділене на сайтах.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, Popover, UiIcon, UiSelect],
  selector: 'app-translator',
  styleUrl: './translator.scss',
  templateUrl: './translator.html',
})
export class Translator {
  /** Адреса сайту в активній вкладці; порожня — у вкладці не сайт. */
  readonly pageUrl = input('');
  /** Відкрити адресу в цій вкладці. */
  readonly navigate = output<string>();
  readonly openInNewTab = output<string>();

  protected readonly languages = TRANSLATE_LANGUAGES;
  protected readonly language = inject(TranslateLanguageStore).language;
  protected readonly text = signal('');
  protected readonly translated = computed(() => isTranslated(this.pageUrl()));
  /** Сайт, що зараз у вкладці, — для перекладеної сторінки її справжній. */
  protected readonly site = computed(() => {
    const url = this.pageUrl();
    return url ? hostname(originalUrl(url) ?? url) : '';
  });

  private readonly popover = viewChild.required(Popover);
  private readonly textInput = viewChild.required<ElementRef<HTMLTextAreaElement>>('textInput');

  show(anchor: HTMLElement): void {
    this.popover().show({ anchor, source: anchor });
  }

  protected onOpened(): void {
    if (!this.pageUrl()) {
      this.textInput().nativeElement.focus();
    }
  }

  protected setLanguage(language: string | undefined): void {
    if (language) {
      this.language.set(language);
    }
  }

  protected translatePage(): void {
    this.popover().hide();
    this.navigate.emit(translatePageUrl(this.pageUrl(), this.language()));
  }

  protected showOriginal(): void {
    const original = originalUrl(this.pageUrl());
    this.popover().hide();
    if (original) {
      this.navigate.emit(original);
    }
  }

  protected translateText(): void {
    const text = this.text().trim();
    if (text) {
      this.popover().hide();
      this.openInNewTab.emit(translateTextUrl(text, this.language()));
    }
  }
}
