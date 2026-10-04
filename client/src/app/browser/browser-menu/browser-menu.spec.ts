import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserMenu } from './browser-menu';

@Component({
  imports: [BrowserMenu],
  template: `<app-browser-menu
    [(zoom)]="zoom"
    (newTab)="events.push('new-tab')"
    (newWindow)="events.push('new-window')"
    (privateWindow)="events.push('private-window')"
    (openPage)="events.push($event)"
    (find)="events.push('find')"
    (print)="events.push('print')"
    (fullscreen)="events.push('fullscreen')" />`,
})
class Host {
  readonly zoom = signal(100);
  readonly events: string[] = [];
}

describe('BrowserMenu', () => {
  const setup = async (zoom = 100) => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.zoom.set(zoom);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const button = (label: string) => element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    const item = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.menu__item')].find((b) => b.textContent?.includes(label));
    return { fixture, element, button, item };
  };

  it('should step the zoom through the same levels as Chrome', async () => {
    const { fixture, element, button } = await setup();

    button('Збільшити масштаб')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.zoom()).toBe(110);
    expect(element.querySelector('.menu__zoom-value')?.textContent).toBe('110%');

    button('Зменшити масштаб')?.click();
    button('Зменшити масштаб')?.click();
    await fixture.whenStable();
    expect(fixture.componentInstance.zoom()).toBe(90);
  });

  it('should disable the zoom buttons at the limits', async () => {
    const min = await setup(25);
    expect(min.button('Зменшити масштаб')?.disabled).toBe(true);
    expect(min.button('Збільшити масштаб')?.disabled).toBe(false);

    TestBed.resetTestingModule();
    const max = await setup(500);
    expect(max.button('Збільшити масштаб')?.disabled).toBe(true);
  });

  it('should emit the actions of the menu items', async () => {
    const { fixture, button, item } = await setup();

    const labels = [
      'Нова вкладка',
      'Нове вікно',
      'Приватне вікно',
      'Історія',
      'Завантаження',
      'Закладки',
      'Знайти на сторінці',
      'Друк',
      'Розширення',
      'Налаштування',
      'Довідка',
    ];
    for (const label of labels) {
      item(label)?.click();
    }
    button('Повноекранний режим')?.click();

    expect(fixture.componentInstance.events).toEqual([
      'new-tab',
      'new-window',
      'private-window',
      'history',
      'downloads',
      'bookmarks',
      'find',
      'print',
      'extensions',
      'settings',
      'help',
      'fullscreen',
    ]);
  });

  it('should announce every shown shortcut to assistive technology', async () => {
    const { element, item } = await setup();

    expect(item('Нова вкладка')?.getAttribute('aria-keyshortcuts')).toBe('Control+T');
    expect(item('Приватне вікно')?.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+N');
    expect(item('Друк')?.querySelector('.menu__shortcut')?.textContent).toBe('Ctrl+P');
    // Кожна показана гаряча клавіша працює, тож кожна оголошена.
    const withShortcut = [...element.querySelectorAll('.menu__item')].filter((menuItem) =>
      menuItem.querySelector('.menu__shortcut')
    );
    expect(withShortcut.every((menuItem) => menuItem.hasAttribute('aria-keyshortcuts'))).toBe(true);
  });
});
