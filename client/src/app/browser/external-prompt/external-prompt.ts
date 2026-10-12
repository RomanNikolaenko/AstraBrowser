import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { ExternalAppsStore, ExternalLinkRequest } from '../data/external-apps';
import { PageViews } from '../page-views/page-views';
import { tr, translate, TranslatePipe } from '../../shared/i18n/i18n';

/** Що відкриє посилання — для тексту запитання. */
const APPS: Readonly<Record<string, string>> = {
  mailto: tr('поштовій програмі'),
  tel: tr('програмі для дзвінків'),
  callto: tr('програмі для дзвінків'),
  sms: tr('програмі для повідомлень'),
  magnet: tr('торрент-клієнті'),
};

/**
 * «Відкрити програму?» — сайт хоче відкрити посилання mailto:, tel:, magnet: тощо програмою на комп'ютері. Без
 * згоди нічого не відкривається; «Завжди дозволяти» запам'ятовує дозвіл для цього сайту й цього виду посилань.
 * Кілька запитів поспіль — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-external-prompt',
  styleUrl: './external-prompt.scss',
  templateUrl: './external-prompt.html',
})
export class ExternalPrompt {
  private readonly apps = inject(ExternalAppsStore);
  private readonly pageViews = inject(PageViews);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly request = signal<ExternalLinkRequest | null>(null);
  protected readonly remember = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected readonly site = computed(() => {
    const origin = this.request()?.origin ?? '';
    try {
      return new URL(origin).hostname;
    } catch {
      return '';
    }
  });
  /** Пошта й дзвінки — загальною назвою (Windows може запропонувати вибрати програму), решта — назвою програми. */
  protected readonly app = computed(() => {
    const request = this.request();
    const app = APPS[request?.scheme ?? ''];
    if (app) {
      return translate(app);
    }
    return request?.app ? translate('програмі «{0}»', [request.app]) : translate('програмі на вашому комп’ютері');
  });
  /** Посилання як його побачить людина: адреса пошти чи номер — без «mailto:», довге — скорочене. */
  protected readonly target = computed(() => {
    const url = this.request()?.url ?? '';
    let text = url;
    try {
      text = decodeURIComponent(url);
    } catch {
      // Лишаємо як є.
    }
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  });

  constructor() {
    effect(() => {
      const next = this.apps.prompts()[0] ?? null;
      untracked(() => {
        if (next?.id === this.request()?.id) {
          return;
        }
        this.request.set(next);
        this.remember.set(false);
        this.error.set(null);
        this.busy.set(false);
        if (next) {
          afterNextRender(
            () => {
              const dialog = this.dialog().nativeElement;
              if (!dialog.open) {
                dialog.showModal?.();
              }
            },
            { injector: this.injector }
          );
        }
      });
    });
  }

  protected setRemember(event: Event): void {
    this.remember.set((event.target as HTMLInputElement).checked);
  }

  protected async open(): Promise<void> {
    const request = this.request();
    if (!request || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.pageViews.openExternal(request.url);
      if (this.remember()) {
        this.apps.allow(request.origin, request.scheme);
      }
      this.finish(request);
    } catch (error) {
      this.error.set(typeof error === 'string' ? error : translate('Не вдалося відкрити посилання.'));
      this.busy.set(false);
    }
  }

  /** «Скасувати», Esc чи клік повз вікно — нічого не відкривається. */
  protected cancel(): void {
    const request = this.request();
    if (request) {
      this.finish(request);
    }
  }

  protected onClose(): void {
    this.cancel();
  }

  private finish(request: ExternalLinkRequest): void {
    this.request.set(null);
    this.dialog().nativeElement.close?.();
    this.apps.answer(request.id);
  }
}
