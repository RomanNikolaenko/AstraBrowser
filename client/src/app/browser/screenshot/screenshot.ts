import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { PageBounds, PageViews } from '../page-views/page-views';
import { hostname } from '../pages/internal-pages';
import { translate, TranslatePipe } from '../../shared/i18n/i18n';

/** Сайт, який знімають: його webview, де він на екрані й адреса (для назви файла). */
export interface ScreenshotPage {
  readonly label: string;
  readonly bounds: PageBounds;
  readonly url: string;
}

interface Area {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Менша область — це клік, а не виділення. */
const MIN_AREA = 8;
/** Скільки показувати «Скопійовано». */
const COPIED_FOR = 1500;
/** За скільки сайт знову з'являється, коли модальне вікно над ним закрили (Browser.onOverlayToggle). */
const SITE_BACK_MS = 450;

const pad = (value: number) => String(value).padStart(2, '0');

/** «Скріншот github.com 2026-10-04 07-55-12.png». */
export function screenshotFileName(url: string, time = new Date()): string {
  const date = `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
  const clock = `${pad(time.getHours())}-${pad(time.getMinutes())}-${pad(time.getSeconds())}`;
  const site = hostname(url).replace(/[\\/:*?"<>|]/g, '');
  return translate('Скріншот {0}.png', [`${site ? `${site} ` : ''}${date} ${clock}`]);
}

/**
 * Скріншот сайту з «Інструментів», як «Знімок вебсторінки» в Edge: сторінка «завмирає», і мишею виділяється область —
 * або знімається вся видима частина чи вся сторінка з прокруткою. Потім — перегляд, «Копіювати» (картинка в буфер)
 * і «Зберегти…» (вікно «Зберегти як» Windows, спершу тека «Зображення»).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-screenshot',
  styleUrl: './screenshot.scss',
  templateUrl: './screenshot.html',
})
export class Screenshot {
  private readonly pageViews = inject(PageViews);

  protected readonly mode = signal<'select' | 'result' | 'message' | null>(null);
  /** Знімок видимої частини, на якому виділяють область. */
  protected readonly view = signal<{
    readonly url: string;
    readonly bounds: PageBounds;
    readonly image: HTMLImageElement;
  } | null>(null);
  protected readonly selection = signal<Area | null>(null);
  protected readonly result = signal<{
    readonly url: string;
    readonly blob: Blob;
    readonly width: number;
    readonly height: number;
  } | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal(false);
  protected readonly savedPath = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly saveButton = viewChild<ElementRef<HTMLButtonElement>>('saveButton');
  private readonly status = viewChild.required<ElementRef<HTMLElement>>('status');
  private readonly injector = inject(Injector);
  private page: ScreenshotPage | null = null;
  /** Вікно закривається лише на час знімання всієї сторінки — знімки скидати не треба. */
  private keepOnClose = false;
  private dragStart: { readonly x: number; readonly y: number } | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.reset());
  }

  /** Почати знімок сайту `page`; null — у вкладці не сайт. */
  async start(page: ScreenshotPage | null): Promise<void> {
    this.reset();
    if (!page) {
      this.showMessage(translate('Скріншот можна зробити лише для сайту — відкрийте сайт у вкладці.'));
      return;
    }
    this.page = page;
    try {
      const blob = new Blob([await this.pageViews.screenshot(page.label, false)], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const image = await loadImage(url);
      this.view.set({ url, bounds: page.bounds, image });
      this.mode.set('select');
      this.open();
    } catch {
      this.showMessage(translate('Не вдалося зняти сторінку. Спробуйте ще раз, коли вона завантажиться.'));
    }
  }

  protected startSelection(event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragStart = this.point(event);
    this.selection.set(null);
  }

  protected moveSelection(event: PointerEvent): void {
    if (!this.dragStart) {
      return;
    }
    const { x, y } = this.point(event);
    this.selection.set({
      x: Math.min(x, this.dragStart.x),
      y: Math.min(y, this.dragStart.y),
      width: Math.abs(x - this.dragStart.x),
      height: Math.abs(y - this.dragStart.y),
    });
  }

  protected async endSelection(event: PointerEvent): Promise<void> {
    if (!this.dragStart) {
      return;
    }
    this.moveSelection(event);
    this.dragStart = null;
    const area = this.selection();
    if (area && area.width >= MIN_AREA && area.height >= MIN_AREA) {
      await this.crop(area);
    } else {
      this.selection.set(null);
    }
  }

  protected async takeVisible(): Promise<void> {
    const view = this.view();
    if (view) {
      await this.crop({ x: 0, y: 0, width: view.bounds.width, height: view.bounds.height });
    }
  }

  protected async takeFullPage(): Promise<void> {
    const page = this.page;
    if (!page || this.busy()) {
      return;
    }
    this.busy.set(true);
    // Під модальним вікном сайт схований, а схована сторінка не малюється — і знімок чекав би вічно.
    // Тож вікно на мить закривається, сторінка знімається видимою, а тоді — результат.
    this.keepOnClose = true;
    this.dialog().nativeElement.close?.();
    this.showStatus(page.bounds);
    try {
      await delay(SITE_BACK_MS);
      const blob = new Blob([await this.pageViews.screenshot(page.label, true)], { type: 'image/png' });
      await this.showResult(blob);
    } catch {
      this.showMessage(translate('Не вдалося зняти всю сторінку.'));
    } finally {
      this.busy.set(false);
      this.status().nativeElement.hidePopover?.();
    }
  }

  protected async copy(): Promise<void> {
    const shot = this.result();
    if (!shot) {
      return;
    }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.blob })]);
      this.copied.set(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), COPIED_FOR);
    } catch {
      this.error.set(translate('Не вдалося скопіювати картинку.'));
    }
  }

  protected async save(): Promise<void> {
    const shot = this.result();
    if (!shot || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const bytes = new Uint8Array(await shot.blob.arrayBuffer());
      const path = await this.pageViews.saveFile(bytes, screenshotFileName(this.page?.url ?? ''), 'png');
      if (path) {
        this.savedPath.set(path);
      }
    } catch {
      this.error.set(translate('Не вдалося зберегти файл.'));
    } finally {
      this.busy.set(false);
    }
  }

  protected showSaved(path: string): void {
    void this.pageViews.showDownload(path).catch(() => undefined);
  }

  protected close(): void {
    this.dialog().nativeElement.close?.();
    this.reset();
  }

  /**
   * Гарячі клавіші вікна. Виділення: Enter — видима частина, Shift+Enter — уся сторінка. Результат: Ctrl+C —
   * копіювати, Ctrl+S — зберегти. Esc закриває саме вікно (подія cancel <dialog>). За event.code — у будь-якій розкладці.
   */
  protected onKeydown(event: KeyboardEvent): void {
    const mode = this.mode();
    if (mode === 'select' && event.key === 'Enter' && !event.ctrlKey && !event.altKey) {
      // І тоді, коли фокус на кнопці панелі: Enter не «натискає» її, а робить те, що обіцяє підказка.
      event.preventDefault();
      void (event.shiftKey ? this.takeFullPage() : this.takeVisible());
    } else if (mode === 'result' && event.ctrlKey && !event.shiftKey && !event.altKey) {
      if (event.code === 'KeyC') {
        event.preventDefault();
        void this.copy();
      } else if (event.code === 'KeyS') {
        event.preventDefault();
        void this.save();
      }
    }
  }

  protected onClose(): void {
    if (this.keepOnClose) {
      this.keepOnClose = false;
      return;
    }
    this.reset();
  }

  /** Закрили (Esc, «Закрити», клік повз вікно): знімки більше не потрібні. */
  protected reset(): void {
    for (const url of [this.view()?.url, this.result()?.url]) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    this.view.set(null);
    this.result.set(null);
    this.selection.set(null);
    this.mode.set(null);
    this.copied.set(false);
    this.savedPath.set(null);
    this.error.set(null);
    this.busy.set(false);
    this.dragStart = null;
    clearTimeout(this.copiedTimer);
  }

  /** Точка на знімку в CSS-пікселях сторінки — не далі за його краї. */
  private point(event: PointerEvent): { x: number; y: number } {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  }

  /** Вирізати область зі знімка видимої частини: знімок — у фізичних пікселях, область — у CSS-пікселях. */
  private async crop(area: Area): Promise<void> {
    const view = this.view();
    if (!view) {
      return;
    }
    const scale = view.image.naturalWidth / view.bounds.width;
    const width = Math.max(1, Math.round(area.width * scale));
    const height = Math.max(1, Math.round(area.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext('2d')
      ?.drawImage(view.image, Math.round(area.x * scale), Math.round(area.y * scale), width, height, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      await this.showResult(blob);
    }
  }

  private async showResult(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    const image = await loadImage(url).catch(() => null);
    const previous = this.result();
    if (previous) {
      URL.revokeObjectURL(previous.url);
    }
    this.result.set({ url, blob, width: image?.naturalWidth ?? 0, height: image?.naturalHeight ?? 0 });
    this.mode.set('result');
    this.open();
    // Вікно вже було відкрите (виділення) — autofocus не спрацює, тож фокус на «Зберегти…» ставимо самі.
    afterNextRender(() => this.saveButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** Плашка вгорі посередині сайту: спершу показуємо, тоді ставимо за її шириною (без transform — під неї рахується отвір). */
  private showStatus(bounds: PageBounds): void {
    const status = this.status().nativeElement;
    status.showPopover?.();
    status.style.left = `${bounds.x + (bounds.width - status.offsetWidth) / 2}px`;
    status.style.top = `${bounds.y + 16}px`;
  }

  private showMessage(message: string): void {
    this.error.set(message);
    this.mode.set('message');
    this.open();
  }

  private open(): void {
    const dialog = this.dialog().nativeElement;
    if (!dialog.open) {
      dialog.showModal?.();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error(translate('Не вдалося прочитати знімок'))), { once: true });
    image.src = url;
  });
}
