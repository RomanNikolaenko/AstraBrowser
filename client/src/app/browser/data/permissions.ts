import { Injectable, signal } from '@angular/core';
import { accountSignal } from '../../shared/storage/stored-signal';
import { tr } from '../../shared/i18n/i18n';

/** Дозвіл сайту, про який питає браузер (server/src/page_events.rs, PERMISSIONS). */
export type PermissionKind =
  | 'camera'
  | 'microphone'
  | 'location'
  | 'notifications'
  | 'clipboard'
  | 'sensors'
  | 'downloads'
  | 'files'
  | 'fonts'
  | 'midi'
  | 'windows';

/** Стан дозволу: дозволено, заборонено чи питати щоразу. */
export type PermissionState = 'allow' | 'deny' | 'ask';

/** Як дозвіл виглядає в запитанні й на панелі дозволів сайту. */
export const PERMISSION_INFO: Readonly<
  Record<PermissionKind, { readonly icon: string; readonly label: string; readonly asks: string }>
> = {
  camera: { icon: 'camera', label: tr('Камера'), asks: tr('Використовувати камеру') },
  microphone: { icon: 'microphone', label: tr('Мікрофон'), asks: tr('Використовувати мікрофон') },
  location: { icon: 'location', label: tr('Геолокація'), asks: tr('Знати, де ви перебуваєте') },
  notifications: { icon: 'bell', label: tr('Сповіщення'), asks: tr('Показувати сповіщення') },
  clipboard: { icon: 'clipboard', label: tr('Буфер обміну'), asks: tr('Бачити текст і зображення, які ви копіюєте') },
  sensors: { icon: 'monitor', label: tr('Датчики руху'), asks: tr('Використовувати датчики руху й освітлення') },
  downloads: { icon: 'download', label: tr('Автоматичні завантаження'), asks: tr('Завантажувати кілька файлів поспіль') },
  files: { icon: 'file', label: tr('Файли'), asks: tr('Змінювати файли й теки на вашому комп’ютері') },
  fonts: { icon: 'edit', label: tr('Шрифти'), asks: tr('Використовувати шрифти, встановлені на комп’ютері') },
  midi: { icon: 'volume', label: tr('MIDI-пристрої'), asks: tr('Повністю керувати MIDI-пристроями') },
  windows: { icon: 'window', label: tr('Вікна'), asks: tr('Відкривати й розташовувати вікна на всіх екранах') },
};

/** Сайт просить дозвіл: який, хто й у якій вкладці (мітка webview сторінки). */
export interface PermissionRequest {
  readonly id: number;
  readonly label: string;
  readonly kind: PermissionKind;
  readonly origin: string;
}

/**
 * Запити дозволів сайтів, що чекають відповіді (їх показує PermissionPrompt), і сайти, яким дозволено відкривати
 * спливні вікна без кліку (дані облікового запису). Самі дозволи (камера, мікрофон…) зберігає профіль WebView2.
 */
@Injectable({ providedIn: 'root' })
export class PermissionsStore {
  readonly prompts = signal<readonly PermissionRequest[]>([]);
  /** Сайти (origin), яким дозволено спливні вікна. */
  private readonly popups = accountSignal<readonly string[]>('astra.popups.allowed', []);

  ask(request: PermissionRequest): void {
    if (!(request.kind in PERMISSION_INFO) || this.prompts().some((item) => item.id === request.id)) {
      return;
    }
    this.prompts.update((list) => [...list, request]);
  }

  answer(id: number): void {
    this.prompts.update((list) => list.filter((request) => request.id !== id));
  }

  /** Запити сторінки, якої вже немає (вкладку закрили), — без відповіді лишатися не мають. */
  forgetPage(label: string): PermissionRequest[] {
    const gone = this.prompts().filter((request) => request.label === label);
    if (gone.length) {
      this.prompts.update((list) => list.filter((request) => request.label !== label));
    }
    return gone;
  }

  popupsAllowed(origin: string): boolean {
    return !!origin && this.popups().includes(origin);
  }

  setPopupsAllowed(origin: string, allowed: boolean): void {
    if (!origin) {
      return;
    }
    this.popups.update((list) => [...list.filter((item) => item !== origin), ...(allowed ? [origin] : [])]);
  }
}
