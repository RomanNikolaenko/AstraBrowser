import { Component, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Popover } from './popover';

@Component({
  imports: [Popover],
  template: `
    <button class="invoker" type="button" popovertarget="demo">Меню</button>
    <app-popover
      class="demo"
      popoverId="demo"
      align="start"
      caret
      (opened)="events.push('opened')"
      (closed)="events.push('closed')">
      <p class="content">Вміст</p>
      <button class="close" type="button" popovertarget="demo" popovertargetaction="hide">Закрити</button>
    </app-popover>
  `,
})
class Host {
  readonly events: string[] = [];
  readonly popover = viewChild.required(Popover);
}

describe('Popover', () => {
  const setup = async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const panel = element.querySelector('.demo .popover') as HTMLElement;
    // jsdom не має Popover API: відкриття й закриття — це події, які шле браузер.
    const toggle = async (type: 'beforetoggle' | 'toggle', newState: 'open' | 'closed') => {
      panel.dispatchEvent(Object.assign(new Event(type), { newState }));
      await fixture.whenStable();
    };
    return { fixture, element, panel, toggle };
  };

  it('should render the content inside a popover the invoker can target', async () => {
    const { panel } = await setup();

    expect(panel.id).toBe('demo');
    expect(panel.hasAttribute('popover')).toBe(true);
    expect(panel.querySelector('.content')?.textContent).toBe('Вміст');
    expect(panel.classList).toContain('popover--start');
    expect(panel.classList).toContain('popover--caret');
    expect(panel.style.getPropertyValue('position-anchor')).toBe('--demo');
  });

  it('should report opening and closing and mark the host while open', async () => {
    const { fixture, element, toggle } = await setup();
    const host = element.querySelector('app-popover') as HTMLElement;

    await toggle('toggle', 'open');
    expect(host.classList).toContain('is-open');

    fixture.componentInstance.popover().hide();
    await fixture.whenStable();
    expect(host.classList).not.toContain('is-open');

    // Подія від браузера після hide() вже нічого не змінює.
    await toggle('toggle', 'closed');
    expect(fixture.componentInstance.events).toEqual(['opened', 'closed']);
  });

  it('should measure the invoker for the caret, not the button that closes the panel', async () => {
    const { element, panel, toggle } = await setup();
    const measured: string[] = [];
    for (const button of element.querySelectorAll<HTMLElement>('button')) {
      button.getBoundingClientRect = () => {
        measured.push(button.className);
        return { width: 40 } as DOMRect;
      };
    }

    await toggle('beforetoggle', 'open');

    expect(measured).toEqual(['invoker']);
    expect(panel.style.getPropertyValue('--popover-anchor-width')).toBe('40px');
  });
});
