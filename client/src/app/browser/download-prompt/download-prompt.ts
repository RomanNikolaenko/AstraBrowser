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
import { SaveTarget } from '../../bindings';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiInput } from '../../shared/ui-input/ui-input';
import { DownloadSettingsStore } from '../data/download-settings';
import { DownloadPromptRequest, DownloadsStore } from '../data/downloads';
import { PageViews } from '../page-views/page-views';
import { formatSize, hostname } from '../pages/internal-pages';
import { TranslatePipe, tr } from '../../shared/i18n/i18n';

/** Символи, яких не може бути в назві файла Windows. */
const FORBIDDEN = /[\\/:*?"<>|]/;
/** Назви пристроїв Windows: файла так назвати не можна навіть із розширенням (con.txt). */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Що не так із назвою файла (як перевіряє server/src/downloads.rs, is_valid_file_name); null — назва годиться. */
export function fileNameProblem(name: string): string | null {
  if (!name.trim()) {
    return tr('Вкажіть назву файла');
  }
  if (FORBIDDEN.test(name) || [...name].some((character) => character < ' ')) {
    return tr('У назві не може бути символів \\ / : * ? " < > |');
  }
  if (/[. ]$/.test(name) || DEVICE.test(name.split('.')[0].trimEnd()) || name.length > 255) {
    return tr('Така назва файла недопустима');
  }
  return null;
}

/**
 * Перед завантаженням: що за файл, під якою назвою (її можна змінити) і в яку теку він ляже. «Зберегти як…» відкриває
 * вікно Windows, де видно файли теки: там можна дати свою назву чи вибрати наявний файл, щоб замінити його, — і файл
 * одразу зберігається туди. Показується, поки в налаштуваннях увімкнено «Питати, куди зберегти файл»; «Більше не
 * питати» це вимикає. А ще — завжди, коли в теці вже є файл із такою назвою: замінити його чи зберегти обидва (новий
 * — «назва (1)»). Кілька запитів поспіль — по черзі.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon, UiInput],
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
  /** Назва файла — спершу та, що запропонував сайт. */
  protected readonly fileName = signal('');
  protected readonly nameProblem = computed(() => fileNameProblem(this.fileName()));
  protected readonly dontAsk = signal(false);
  /** У теці вже є файл із такою назвою. */
  protected readonly exists = signal(false);
  /**
   * «Більше не питати» — лише коли питати увімкнено: вікно, що з'явилося лише через наявний файл, і з вимкненим
   * налаштуванням показується знову, тож пропонувати вимкнути нічого.
   */
  protected readonly offerDontAsk = computed(() => !(this.request()?.exists && this.settings.settings()?.ask === false));

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly nameInput = viewChild(UiInput);

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
          this.fileName.set(next.fileName);
          this.exists.set(!!next.exists);
          this.dontAsk.set(false);
          afterNextRender(
            () => {
              const dialog = this.dialog().nativeElement;
              if (!dialog.open) {
                dialog.showModal?.();
              }
              // Як «Зберегти як» Windows: курсор у назві, виділена назва без розширення — можна одразу писати свою,
              // а Enter зберігає.
              this.nameInput()?.focus();
              this.selectStem();
            },
            { injector: this.injector }
          );
        }
      });
    });
  }

  /** Нова назва: чи є вже в теці файл із нею. */
  protected async rename(name: string): Promise<void> {
    this.fileName.set(name);
    const request = this.request();
    const exists =
      !!request && !fileNameProblem(name) && (await this.pageViews.downloadFileExists(this.folder(), name).catch(() => false));
    // Поки чекали відповіді, назву могли змінити ще раз.
    if (this.request() === request && this.fileName() === name) {
      this.exists.set(exists);
    }
  }

  /** Виділяє назву без розширення, як перейменування в Провіднику. */
  protected selectStem(): void {
    const name = this.fileName();
    const dot = name.lastIndexOf('.');
    this.nameInput()?.selectRange(0, dot > 0 ? dot : name.length);
  }

  /**
   * Вікно «Зберегти як» Windows: інша тека, своя назва чи наявний файл, який замінити (заміну система підтверджує
   * сама), — і файл одразу туди.
   */
  protected async saveAs(): Promise<void> {
    const request = this.request();
    if (!request) {
      return;
    }
    const name = this.nameProblem() ? request.fileName : this.fileName();
    const picked = await this.pageViews.saveDownloadAs(this.folder(), name).catch(() => null);
    if (picked && this.request() === request) {
      this.folder.set(picked.folder);
      this.fileName.set(picked.fileName);
      this.save(true);
    }
  }

  /** `replace` — наявний файл із такою назвою замінити; інакше новий ляже поряд. */
  protected save(replace: boolean): void {
    if (this.nameProblem()) {
      return;
    }
    if (this.dontAsk()) {
      void this.settings.setAsk(false).catch(() => undefined);
    }
    this.answer({ folder: this.folder(), fileName: this.fileName(), replace });
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

  private answer(target: SaveTarget | null): void {
    const request = this.request();
    if (!request) {
      return;
    }
    this.request.set(null);
    this.dialog().nativeElement.close?.();
    this.downloads.answerPrompt(request.id);
    void this.pageViews.resolveDownload(request.id, target).catch(() => undefined);
  }
}
