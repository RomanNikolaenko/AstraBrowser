import { DOCUMENT, DestroyRef, inject } from '@angular/core';
import { BrowserWindows } from '../browser-windows/browser-windows';

/**
 * Порожні місця заголовка, за які тягнуть вікно: `data-drag-region` — лише сам елемент, `"deep"` — і все в ньому,
 * `"false"` — тут не тягнути (як `data-tauri-drag-region` у Tauri).
 */
export const DRAG_REGION_ATTRIBUTE = 'data-drag-region';

/** На скільки пікселів зсунути мишу з натиснутою кнопкою, щоб вікно почало рухатися (як SM_CXDRAG у Windows). */
const DRAG_THRESHOLD = 4;

const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);

function isClickable(element: HTMLElement): boolean {
  const editable = element.getAttribute('contenteditable');
  const tabindex = element.getAttribute('tabindex');
  return (
    CLICKABLE_TAGS.has(element.tagName) ||
    (editable !== null && editable !== 'false') ||
    (tabindex !== null && tabindex !== '-1') ||
    INTERACTIVE_ROLES.has(element.getAttribute('role') ?? '')
  );
}

/** Чи натиснули на область перетягування: кнопки й поля на шляху вгору її перекривають. */
export function isDragRegion(path: readonly EventTarget[]): boolean {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) {
      continue;
    }
    const value = target.getAttribute(DRAG_REGION_ATTRIBUTE);
    if (value === null) {
      if (isClickable(target)) {
        return false;
      }
      continue;
    }
    if (value === 'false') {
      return false;
    }
    return value === 'deep' || target === path[0];
  }
  return false;
}

/**
 * Перетягування вікна за порожні місця заголовка (`data-drag-region`) і подвійний клік по них — розгорнути чи
 * відновити вікно.
 *
 * Вікно рушає, лише коли мишу з натиснутою кнопкою зсунули на кілька пікселів, — як заголовок звичайного вікна
 * Windows. Tauri (`data-tauri-drag-region`) запускав перетягування вже на натисканні, і розгорнуте вікно часом
 * зменшувалося від звичайного кліку (server/src/window_drag.rs).
 *
 * Викликати в контексті впровадження (конструктор кореневого компонента).
 */
export function enableWindowDrag(): void {
  const document = inject(DOCUMENT);
  const windows = inject(BrowserWindows);
  let start: { readonly x: number; readonly y: number } | null = null;

  const stop = () => {
    start = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('mouseup', stop, true);
    window.removeEventListener('blur', stop);
  };

  const onMove = (event: MouseEvent) => {
    if (!start || !(event.buttons & 1)) {
      stop();
      return;
    }
    if (Math.hypot(event.screenX - start.x, event.screenY - start.y) >= DRAG_THRESHOLD) {
      stop();
      void windows.startDragging();
    }
  };

  const onDown = (event: MouseEvent) => {
    // Другий клік подвійного — не перетягування, а dblclick нижче.
    if (event.button !== 0 || event.detail > 1 || !isDragRegion(event.composedPath())) {
      return;
    }
    // Без виділення тексту заголовка.
    event.preventDefault();
    start = { x: event.screenX, y: event.screenY };
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', stop, true);
    window.addEventListener('blur', stop);
  };

  const onDoubleClick = (event: MouseEvent) => {
    if (event.button === 0 && isDragRegion(event.composedPath())) {
      void windows.toggleMaximize();
    }
  };

  document.addEventListener('mousedown', onDown);
  document.addEventListener('dblclick', onDoubleClick);
  inject(DestroyRef).onDestroy(() => {
    stop();
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('dblclick', onDoubleClick);
  });
}
