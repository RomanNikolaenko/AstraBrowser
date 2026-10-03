import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';

// Імена для ::highlight() у глобальних стилях (styles.scss).
const ALL_MATCHES = 'find-matches';
const CURRENT_MATCH = 'find-current';

/** Усі входження тексту в видимих текстових вузлах `root`, без урахування регістру. */
export function findMatches(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLocaleLowerCase('uk');
  if (!needle) {
    return [];
  }

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      const visible = parent && !parent.closest('input, textarea, script, style') && (parent.checkVisibility?.() ?? true);
      return visible ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.textContent ?? '').toLocaleLowerCase('uk');
    for (let index = text.indexOf(needle); index !== -1; index = text.indexOf(needle, index + needle.length)) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Пошук на сторінці (Ctrl+F): підсвічує збіги в `root` і переходить між ними. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon, UiInput],
  selector: 'app-find-bar',
  styleUrl: './find-bar.scss',
  templateUrl: './find-bar.html',
})
export class FindBar {
  readonly root = input.required<HTMLElement>();
  /**
   * Пошук у сайті (його DOM в окремому webview, сюди недоступний): виділяє наступний чи попередній збіг
   * і каже, чи знайшовся. Без нього панель шукає й підсвічує збіги в `root` сама.
   */
  readonly finder = input<(query: string, backwards: boolean) => Promise<boolean>>();
  readonly closed = output();

  protected readonly query = signal('');
  protected readonly current = signal(0);
  private readonly matches = signal<readonly Range[]>([]);
  /** Результат останнього пошуку в сайті; null — ще не шукали. */
  private readonly found = signal<boolean | null>(null);

  protected readonly total = computed(() => this.matches().length);
  protected readonly canStep = computed(() => (this.finder() ? !!this.found() : this.total() > 0));
  protected readonly notFound = computed(() => !!this.query().trim() && (this.finder() ? this.found() === false : !this.total()));
  protected readonly status = computed(() => {
    if (!this.query().trim()) {
      return '';
    }
    if (this.finder()) {
      return this.found() === null ? '' : this.found() ? 'Знайдено' : 'Немає збігів';
    }
    return this.total() ? `${this.current() + 1} / ${this.total()}` : 'Немає збігів';
  });

  private readonly field = viewChild.required(UiInput);

  constructor() {
    effect(() => {
      const query = this.query();
      const root = this.root();
      const finder = this.finder();
      untracked(() => {
        if (finder) {
          this.found.set(null);
          if (query.trim()) {
            void finder(query, false).then((found) => this.found.set(found));
          }
          return;
        }
        this.matches.set(findMatches(root, query));
        this.current.set(0);
      });
    });

    effect(() => this.highlight(this.matches(), this.current()));

    afterNextRender(() => this.focus());
    inject(DestroyRef).onDestroy(() => this.clearHighlights());
  }

  focus(): void {
    this.field().focus();
    this.field().select();
  }

  protected next(): void {
    this.step(false);
  }

  protected previous(): void {
    this.step(true);
  }

  private step(backwards: boolean): void {
    const finder = this.finder();
    if (finder) {
      if (this.query().trim()) {
        void finder(this.query(), backwards).then((found) => this.found.set(found));
      }
    } else if (this.total()) {
      this.current.update((index) => (index + (backwards ? -1 : 1) + this.total()) % this.total());
    }
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) {
        this.previous();
      } else {
        this.next();
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closed.emit();
    }
  }

  private highlight(matches: readonly Range[], current: number): void {
    // CSS Custom Highlight API: підсвітка без зміни DOM сторінки. У jsdom (тести) її немає.
    if (typeof Highlight === 'undefined') {
      return;
    }

    CSS.highlights.set(ALL_MATCHES, new Highlight(...matches));
    const match = matches[current];
    if (match) {
      CSS.highlights.set(CURRENT_MATCH, new Highlight(match));
      match.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } else {
      CSS.highlights.delete(CURRENT_MATCH);
    }
  }

  private clearHighlights(): void {
    if (typeof Highlight !== 'undefined') {
      CSS.highlights.delete(ALL_MATCHES);
      CSS.highlights.delete(CURRENT_MATCH);
    }
  }
}
