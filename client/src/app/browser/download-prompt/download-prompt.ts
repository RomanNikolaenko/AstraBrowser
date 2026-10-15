import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { DownloadSettingsStore } from '../data/download-settings';
import { DownloadPromptRequest, DownloadsStore } from '../data/downloads';
import { PageViews } from '../page-views/page-views';
import { formatSize, hostname } from '../pages/internal-pages';
import { TranslatePipe } from '../../shared/i18n/i18n';

/**
 * Перед завантаженням: що за файл і в яку теку він ляже, з можливістю вибрати іншу теку лише для нього
 * (як «Зберегти як»). Показується, поки в налаштуваннях увімкнено «Питати, куди зберегти файл»;
 * «Більше не питати» це вимикає. А ще — завжди, коли в теці вже є файл із такою назвою: замінити його чи зберегти
 * обидва (новий — «назва (1)»). Кілька запитів поспіль — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-download-prompt',
  styleUrl: './download-prompt.scss',
  templateUrl: './download-prompt.html',
})
export class DownloadPrompt {
  protected readonly downloads = inject(DownloadsStore);
  private readonly settings = inject(DownloadSettingsStore);
  private readonly pageViews = inject(PageViews);
  private readonly injector = inject(Injector);

  /** Запит, який зараз показано. */
  protected readonly request = signal<DownloadPromptRequest | null>(null);
  /** Тека саме для цього файла — спершу та, що в налаштуваннях. */
  protected readonly folder = signal('');
  protected readonly dontAsk = signal(false);
  /** У вибраній теці вже є файл із такою назвою. */
  protected readonly exists = signal(false);
  /**
   * «Більше не питати» — лише коли питати увімкнено: вікно, що з'явилося лише через наявний файл, і з вимкненим
   * налаштуванням показується знову, тож пропонувати вимкнути нічого.
   */
  protected readonly offerDontAsk = computed(() => !(this.request()?.exists && this.settings.settings()?.ask === false));

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly formatSize = formatSize;
  protected readonly hostname = hostname;

  constructor() {
    // Наступний у черзі запит показується, щойно попередній вирішено.
    effect(() => {
      const next = this.downloads.prompts()[0] ?? null;
      untracked(() => {
        if (next?.id === this.request()?.id) {
          return;
        }
        this.request.set(next);
        if (next) {
          this.folder.set(next.folder);
          this.exists.set(!!next.exists);
          this.dontAsk.set(false);
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

  protected async changeFolder(): Promise<void> {
    const picked = await this.pageViews.pickDownloadFolder(this.folder()).catch(() => null);
    const request = this.request();
    if (picked && request) {
      this.folder.set(picked);
      this.exists.set(await this.pageViews.downloadFileExists(picked, request.fileName).catch(() => false));
    }
  }

  /** `replace` — наявний файл із такою назвою замінити; інакше новий ляже поряд. */
  protected save(replace: boolean): void {
    if (this.dontAsk()) {
      void this.settings.setAsk(false).catch(() => undefined);
    }
    this.answer(this.folder(), replace);
  }

  /** «Скасувати», Esc чи клік повз вікно — файл не завантажується. */
  protected cancel(): void {
    this.answer(null);
  }

  protected setDontAsk(event: Event): void {
    this.dontAsk.set((event.target as HTMLInputElement).checked);
  }

  protected onClose(): void {
    if (this.request()) {
      this.answer(null);
    }
  }

  private answer(folder: string | null, replace = false): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.request.set(null);
    this.dialog().nativeElement.close?.();
    this.downloads.answerPrompt(request.id);
    void this.pageViews.resolveDownload(request.id, folder, replace).catch(() => undefined);
  }
}
