import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppUpdate, UpdateStore } from '../data/updates';
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

/** Оновлення без Tauri: стан задає тест. */
class FakeUpdates {
  readonly available = signal<AppUpdate | null>(null);
  readonly current = signal<string | null>('0.1.0');
  readonly installing = signal(false);
  readonly percent = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  readonly canInstall = computed(() => this.available() !== null && !this.installing());
  readonly install = vi.fn(() => {
    this.installing.set(true);
    return Promise.resolve();
  });
  readonly markSeen = vi.fn();
}

describe('BrowserMenu', () => {
  let updates: FakeUpdates;

  const setup = async (zoom = 100) => {
    updates = new FakeUpdates();
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: UpdateStore, useValue: updates }],
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

  it('should leave the page source and developer tools to the context menu and shortcuts', async () => {
    const { item } = await setup();

    expect(item('Переглянути джерело сторінки')).toBeUndefined();
    expect(item('Інструменти розробника')).toBeUndefined();
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

  it('should mark the update as seen whenever the menu opens', async () => {
    const { fixture, element } = await setup();
    const panel = element.querySelector('#browser-menu') as HTMLElement;

    panel.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
    await fixture.whenStable();
    expect(updates.markSeen).toHaveBeenCalledTimes(1);
  });

  it('should not offer reopening a closed tab: that is Ctrl+Shift+T', async () => {
    const { item } = await setup();

    expect(item('Відновити закриту вкладку')).toBeUndefined();
  });

  it('should keep the update item disabled until a newer version is out, then install it', async () => {
    const { fixture, element, item } = await setup();
    const update = () => item('Оновити Astra Browser') as HTMLButtonElement;

    expect(update().disabled).toBe(true);
    expect(update().title).toBe('Оновлень немає — у вас найновіша версія 0.1.0');
    expect(element.querySelector('.menu__version')?.textContent?.trim()).toBe('0.1.0');
    // Пункт оновлення — останній у меню.
    expect([...element.querySelectorAll('.menu__item')].at(-1)).toBe(update());

    updates.available.set({ version: '0.2.0', notes: 'Швидші вкладки' });
    await fixture.whenStable();
    expect(update().disabled).toBe(false);
    expect(update().title).toBe('Встановити версію 0.2.0: Швидші вкладки');
    expect(element.querySelector('.menu__version--new')?.textContent?.trim()).toBe('0.2.0');

    update().click();
    updates.percent.set(45);
    await fixture.whenStable();
    expect(updates.install).toHaveBeenCalledTimes(1);
    expect(item('Оновлюємо Astra Browser…')?.disabled).toBe(true);
    expect(element.querySelector('.menu__version')?.textContent?.trim()).toBe('45%');
  });
});
