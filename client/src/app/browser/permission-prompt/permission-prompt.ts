import { ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { PERMISSION_INFO, PermissionRequest, PermissionsStore, PermissionState } from '../data/permissions';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';

/**
 * «Сайт хоче: використовувати камеру» — під адресним рядком, як у Chrome. «Дозволити цього разу» діє, поки відкрита
 * сторінка; «Дозволяти завжди» й «Не дозволяти» запам'ятовуються для сайту (їх видно й змінити можна на панелі
 * дозволів). Закрили, не відповівши, — не дозволено цього разу. Кілька запитів — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon],
  selector: 'app-permission-prompt',
  styleUrl: './permission-prompt.scss',
  templateUrl: './permission-prompt.html',
})
export class PermissionPrompt {
  /** Під чим показувати (адресний рядок). */
  readonly anchor = input.required<HTMLElement>();

  private readonly permissions = inject(PermissionsStore);
  private readonly pageViews = inject(PageViews);
  private readonly popover = viewChild.required(Popover);

  protected readonly request = computed<PermissionRequest | null>(() => this.permissions.prompts()[0] ?? null);
  protected readonly info = computed(() => {
    const request = this.request();
    return request ? PERMISSION_INFO[request.kind] : null;
  });
  protected readonly site = computed(() => {
    try {
      return new URL(this.request()?.origin ?? '').host;
    } catch {
      return 'Сайт';
    }
  });
  /** Запит, на який уже відповіли кнопкою, — закриття панелі після цього не означає «ні». */
  private answered: number | null = null;

  constructor() {
    effect(() => {
      const request = this.request();
      untracked(() => {
        if (request) {
          this.popover().show({ anchor: this.anchor() });
        } else if (this.popover().isOpen()) {
          this.popover().hide();
        }
      });
    });
  }

  protected answer(state: PermissionState, remember: boolean): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.answered = request.id;
    void this.pageViews.answerPermission(request.id, state, remember).catch(() => undefined);
    this.permissions.answer(request.id);
  }

  /** Закрили панель (Esc, клік повз неї) без відповіді — не дозволено, але й не запам'ятовано. */
  protected onClosed(): void {
    const request = this.request();
    if (request && request.id !== this.answered) {
      this.answer('deny', false);
    }
  }
}
