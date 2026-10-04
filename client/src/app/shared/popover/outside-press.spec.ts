import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { closePopoversOnOutsidePress } from './outside-press';

@Component({
  template: `
    <header class="drag" data-tauri-drag-region>
      <button class="invoker" type="button" popovertarget="panel">Меню</button>
    </header>
    <div class="panel" id="panel" popover>
      <button class="inside" type="button">Пункт</button>
      <div class="list" popover></div>
    </div>
    <div class="context" popover><button class="context-item" type="button">Змінити</button></div>
  `,
})
class Host {
  constructor() {
    closePopoversOnOutsidePress();
  }
}

describe('closePopoversOnOutsidePress', () => {
  // jsdom не має Popover API: «відкриті» панелі й закриття підставляємо самі.
  const setup = async (...openSelectors: string[]) => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const hidden: string[] = [];
    for (const selector of openSelectors) {
      const popover = element.querySelector(selector) as HTMLElement;
      Object.assign(popover, {
        matches: (query: string) => query === ':popover-open' || Element.prototype.matches.call(popover, query),
        hidePopover: () => hidden.push(selector),
      });
    }
    const press = (selector: string, button = 0) =>
      element.querySelector(selector)?.dispatchEvent(new MouseEvent('pointerdown', { button, bubbles: true }));
    return { press, hidden };
  };

  it('should close the panel when the press lands on a window drag region', async () => {
    const { press, hidden } = await setup('.panel');

    press('.drag');

    expect(hidden).toEqual(['.panel']);
  });

  it('should keep the panel for presses inside it, on its button and with other mouse buttons', async () => {
    const { press, hidden } = await setup('.panel');

    press('.inside');
    press('.invoker');
    press('.drag', 2);

    expect(hidden).toEqual([]);
  });

  it('should close only a nested popover when the press is elsewhere in its panel', async () => {
    const { press, hidden } = await setup('.panel', '.list');

    press('.inside');

    expect(hidden).toEqual(['.list']);
  });

  it('should keep the panel a menu was opened from when the press is in that menu', async () => {
    // Контекстне меню, відкрите з панелі (showPopover({ source })), але в іншому місці DOM: закрити панель — закрити й його.
    const { press, hidden } = await setup('.panel', '.context');

    press('.context-item');

    expect(hidden).toEqual([]);
  });
});
