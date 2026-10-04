import { DOCUMENT, DestroyRef, inject } from '@angular/core';

/**
 * Закриває відкриті панелі (popover) натисканням миші поза ними — на будь-якому екрані.
 *
 * Popover API і сам закриває панель кліком поза нею, але лише коли кнопку миші відпустили на сторінці.
 * На порожніх місцях заголовка (data-drag-region) мишу забирає система, щойно вікно починають тягнути,
 * і цього не стається. Тож закриваємо вже на натисканні.
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
    const open = [...document.querySelectorAll<HTMLElement>('[popover="auto"], [popover=""]')].filter((popover) =>
      popover.matches(':popover-open')
    );
    // Натиснули в панелі: закриваються лише вкладені в неї (список у панелі). Панелі, з яких її відкрили, але які
    // живуть деінде в DOM (контекстне меню з меню теки закладок), лишаються: закрити їх — закрити й цю панель.
    const clicked = open.filter((popover) => popover.contains(target)).at(-1);
    for (const popover of open.reverse()) {
      if (!popover.contains(target) && (!clicked || clicked.contains(popover))) {
        popover.hidePopover();
      }
    }
  };

  document.addEventListener('pointerdown', onPress, true);
  inject(DestroyRef).onDestroy(() => document.removeEventListener('pointerdown', onPress, true));
}
