import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserWindows } from '../browser-windows/browser-windows';
import { enableWindowDrag, isDragRegion } from './window-drag';

@Component({
  template: `
    <header class="titlebar" data-drag-region>
      <span class="title" data-drag-region>Astra Browser</span>
      <button class="button" type="button">Меню</button>
      <div class="deep" data-drag-region="deep"><span class="inner">Глибоко</span></div>
      <div class="list" data-drag-region="false"><span class="option">Пункт</span></div>
    </header>
  `,
})
class Host {
  constructor() {
    enableWindowDrag();
  }
}

describe('enableWindowDrag', () => {
  const windows = { startDragging: vi.fn(), toggleMaximize: vi.fn() };
  let element: HTMLElement;

  const mouse = (target: EventTarget | null, type: string, init: MouseEventInit = {}) =>
    target?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  const find = (selector: string) => element.querySelector(selector);

  beforeEach(async () => {
    windows.startDragging.mockReset().mockResolvedValue(undefined);
    windows.toggleMaximize.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [{ provide: BrowserWindows, useValue: windows }] });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    element = fixture.nativeElement as HTMLElement;
  });

  it('should not move the window on a plain click, even with a tiny jitter', () => {
    mouse(find('.titlebar'), 'mousedown', { detail: 1, screenX: 100, screenY: 10 });
    mouse(document, 'mousemove', { buttons: 1, screenX: 102, screenY: 11 });
    mouse(document, 'mouseup', { screenX: 102, screenY: 11 });

    expect(windows.startDragging).not.toHaveBeenCalled();
    expect(windows.toggleMaximize).not.toHaveBeenCalled();
  });

  it('should start dragging once the mouse moves with the button held', () => {
    mouse(find('.title'), 'mousedown', { detail: 1, screenX: 100, screenY: 10 });
    mouse(document, 'mousemove', { buttons: 1, screenX: 106, screenY: 10 });
    mouse(document, 'mousemove', { buttons: 1, screenX: 140, screenY: 30 });

    expect(windows.startDragging).toHaveBeenCalledTimes(1);
  });

  it('should not drag after the button was released', () => {
    mouse(find('.titlebar'), 'mousedown', { detail: 1, screenX: 100, screenY: 10 });
    mouse(document, 'mousemove', { buttons: 0, screenX: 140, screenY: 10 });

    expect(windows.startDragging).not.toHaveBeenCalled();
  });

  it('should maximize or restore on a double click of the free space only', () => {
    mouse(find('.titlebar'), 'dblclick', { detail: 2 });
    mouse(find('.button'), 'dblclick', { detail: 2 });
    mouse(find('.option'), 'dblclick', { detail: 2 });
    mouse(find('.inner'), 'dblclick', { detail: 2 });

    expect(windows.toggleMaximize).toHaveBeenCalledTimes(2);
  });

  it('should treat buttons, «false» areas and children of bare regions as not draggable', () => {
    const path = (selector: string) => {
      const target = find(selector);
      const result: EventTarget[] = [];
      for (let node: Element | null = target; node; node = node.parentElement) {
        result.push(node);
      }
      return result;
    };

    expect(isDragRegion(path('.titlebar'))).toBe(true);
    expect(isDragRegion(path('.button'))).toBe(false);
    expect(isDragRegion(path('.option'))).toBe(false);
    expect(isDragRegion(path('.inner'))).toBe(true);
    // Звичайна область — лише сама: дитина без атрибута її не продовжує.
    expect(isDragRegion([find('.deep') as Element, ...path('.titlebar')])).toBe(true);
  });
});
