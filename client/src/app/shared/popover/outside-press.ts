import { DOCUMENT, DestroyRef, inject } from '@angular/core';

/**
 * Закриває відкриті панелі (popover) натисканням миші поза ними — на будь-якому екрані.
 *
 * Popover API і сам закриває панель кліком поза нею, але лише коли кнопку миші відпустили на сторінці.
 * На порожніх місцях заголовка й панелей (data-tauri-drag-region) мишу одразу забирає система
 * для перетягування вікна, і цього не стається. Тож закриваємо вже на натисканні.
 *
 * Викликати в контексті впровадження (конструктор кореневого компонента).
 */
export function closePopoversOnOutsidePress(): void {
  const document = inject(DOCUMENT);

  const onPress = (event: PointerEvent) => {
    const target = event.target;
    // Кнопка з popovertarget відкриває й закриває свою панель сама.
    if (event.button !== 0 || !(target instanceof Element) || target.closest('[popovertarget]')) {
      return;
    }
    // Від верхньої до нижньої: вкладена (список у панелі) закривається, а панель, у якій клікнули, лишається.
    const open = [...document.querySelectorAll<HTMLElement>('[popover="auto"], [popover=""]')].filter((popover) => popover.matches(':popover-open'));
    for (const popover of open.reverse()) {
      if (!popover.contains(target)) {
        popover.hidePopover();
      }
    }
  };

  document.addEventListener('pointerdown', onPress, true);
  inject(DestroyRef).onDestroy(() => document.removeEventListener('pointerdown', onPress, true));
}
