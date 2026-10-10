import { ChangeDetectionStrategy, Component, ElementRef, effect, input, output, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { SiteIcon } from '../site-icon/site-icon';
import { Suggestion } from './suggestions';

/** id списку й пунктів — для aria-controls і aria-activedescendant адресного рядка. */
export const SUGGESTIONS_ID = 'omnibox-suggestions';
export function suggestionId(index: number): string {
  return `${SUGGESTIONS_ID}-${index}`;
}

/**
 * Список підказок під адресним рядком. Фокус лишається в рядку (стрілки, Enter, Esc обробляє Browser), а список
 * лише показує їх і повідомляє про клік. Це popover="manual": його показ і сховування — від Browser, а над сайтом
 * у webview під нього вирізається отвір, як і під інші панелі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SiteIcon, UiIcon],
  selector: 'app-omnibox-suggestions',
  styleUrl: './omnibox-suggestions.scss',
  templateUrl: './omnibox-suggestions.html',
})
export class OmniboxSuggestions {
  readonly open = input.required<boolean>();
  readonly suggestions = input.required<readonly Suggestion[]>();
  /** Підказка, на яку перейшли стрілками; -1 — жодна. */
  readonly selected = input.required<number>();
  readonly pick = output<Suggestion>();
  readonly highlight = output<number>();

  protected readonly listId = SUGGESTIONS_ID;
  protected readonly optionId = suggestionId;
  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  constructor() {
    effect(() => {
      const list = this.list().nativeElement;
      const visible = this.open() && this.suggestions().length > 0;
      if (visible && !list.matches(':popover-open')) {
        list.showPopover?.();
      } else if (!visible && list.matches(':popover-open')) {
        list.hidePopover?.();
      }
    });
  }

  protected icon(suggestion: Suggestion): string | null {
    switch (suggestion.kind) {
      case 'search':
        return 'search';
      case 'bookmark':
        return null;
      case 'tab':
        return 'tab-plus';
      default:
        return null;
    }
  }

  protected siteUrl(suggestion: Suggestion): string | null {
    return 'url' in suggestion ? suggestion.url : null;
  }

  /** Клік не забирає фокус з адресного рядка — інакше той сховав би список ще до кліку. */
  protected keepFocus(event: MouseEvent): void {
    event.preventDefault();
  }
}
