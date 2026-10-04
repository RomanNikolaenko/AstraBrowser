import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { Titlebar } from '../shared/titlebar/titlebar';
import { Browser } from './browser';
import { BookmarksStore } from './data/bookmarks';

// Вкладки браузера рендеряться в спільному заголовку вікна, тож тестуємо їх разом, як в App.
@Component({
  imports: [Browser, Titlebar],
  template: '<app-titlebar /><app-browser />',
})
class Host {}

class FakeWindows {
  readonly isPrivate = false;
  readonly opened: boolean[] = [];
  maximizeToggles = 0;

  open({ private: isPrivate = false } = {}): void {
    this.opened.push(isPrivate);
  }

  toggleMaximize(): Promise<void> {
    this.maximizeToggles++;
    return Promise.resolve();
  }
}

describe('Browser', () => {
  let fixture: ComponentFixture<Host>;
  let element: HTMLElement;
  let windows: FakeWindows;

  const tabs = () => [...element.querySelectorAll('.tab')];
  const activeIndex = () => tabs().findIndex((tab) => tab.classList.contains('tab--active'));
  const menuItem = (label: string) =>
    [...element.querySelectorAll<HTMLButtonElement>('.menu__item')].find((item) => item.textContent?.includes(label));

  const click = async (button: HTMLElement | null | undefined) => {
    button?.click();
    await fixture.whenStable();
  };
  const openTab = () => click(element.querySelector<HTMLButtonElement>('.new-tab-button'));
  const selectTab = (index: number) => click(element.querySelectorAll<HTMLButtonElement>('.tab__select')[index]);
  const closeTab = (index: number) => click(element.querySelectorAll<HTMLButtonElement>('.tab__close')[index]);
  const mouseClick = async (target: Element | null | undefined, button: number) => {
    const down = new MouseEvent('mousedown', { button, bubbles: true, cancelable: true });
    target?.dispatchEvent(down);
    target?.dispatchEvent(new MouseEvent(button === 0 ? 'click' : 'auxclick', { button, bubbles: true, cancelable: true }));
    await fixture.whenStable();
    return down;
  };
  const press = async (init: KeyboardEventInit) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, cancelable: true, ...init }));
    await fixture.whenStable();
  };

  beforeEach(async () => {
    localStorage.clear();
    delete document.documentElement.dataset['theme'];
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: BrowserWindows, useClass: FakeWindows },
      ],
    }).compileComponents();

    windows = TestBed.inject(BrowserWindows) as unknown as FakeWindows;
    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('should start with a single new tab', () => {
    expect(tabs().length).toBe(1);
    expect(element.querySelector('.tab__title')?.textContent?.trim()).toBe('Нова вкладка');
    expect(element.querySelector('app-new-tab')).toBeTruthy();
    expect(element.querySelectorAll('.bookmark').length).toBe(0);
    expect(element.querySelector('.bookmarks__empty')?.textContent).toContain('Щоб додати закладку');
    // На новій вкладці ні йти, ні оновлювати нікуди — кнопки неактивні.
    for (const name of ['Назад', 'Вперед', 'Оновити']) {
      expect(element.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)?.disabled).toBe(true);
    }
  });

  it('should open a new tab, make it active and put the cursor into the address bar', async () => {
    const omnibox = () => element.querySelector<HTMLInputElement>('#omnibox') as HTMLInputElement;
    // У пошуку першої нової вкладки щось набрали; фокус пішов з адресного рядка.
    const search = () => element.querySelector<HTMLInputElement>('#new-tab-search') as HTMLInputElement;
    search().value = 'angular';
    search().dispatchEvent(new Event('input'));
    search().focus();
    await fixture.whenStable();

    await openTab();

    expect(tabs().length).toBe(2);
    expect(activeIndex()).toBe(1);
    expect(document.activeElement).toBe(omnibox());
    // У кожної нової вкладки своя сторінка: набране в іншій сюди не переїжджає.
    expect(search().value).toBe('');

    // Перейшли на іншу нову вкладку — курсор знову в адресному рядку.
    search().focus();
    await selectTab(0);
    expect(document.activeElement).toBe(omnibox());
  });

  it('should activate the tab to the right when the active tab is closed, or the left one if it was last', async () => {
    await openTab();
    await openTab();
    await selectTab(0);

    await closeTab(0);
    expect(tabs().length).toBe(2);
    expect(activeIndex()).toBe(0);

    await selectTab(1);
    await closeTab(1);
    expect(tabs().length).toBe(1);
    expect(activeIndex()).toBe(0);
  });

  it('should keep the active tab when another tab is closed', async () => {
    await openTab();
    await closeTab(0);

    expect(tabs().length).toBe(1);
    expect(activeIndex()).toBe(0);
  });

  it('should replace the last closed tab with a new one', async () => {
    await closeTab(0);

    expect(tabs().length).toBe(1);
    expect(activeIndex()).toBe(0);
  });

  it('should close a tab with the middle mouse button', async () => {
    await openTab();

    const down = await mouseClick(element.querySelectorAll('.tab__title')[0], 1);

    expect(down.defaultPrevented).toBe(true);
    expect(tabs().length).toBe(1);
    expect(activeIndex()).toBe(0);
  });

  it('should open a new tab with the middle mouse button on the free space of the titlebar', async () => {
    const spacer = element.querySelector('.titlebar__spacer');

    await mouseClick(spacer, 0);
    await mouseClick(spacer, 2);
    expect(tabs().length).toBe(1);

    await mouseClick(spacer, 1);
    expect(tabs().length).toBe(2);
    expect(activeIndex()).toBe(1);
  });

  it('should not drag the window by the browser panels but maximize it on a double click on their free space', async () => {
    const doubleClick = async (selector: string) => {
      element.querySelector(selector)?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await fixture.whenStable();
    };
    // data-drag-region="false" (список вибору) — навпаки, «не перетягувати».
    const dragRegion = '[data-drag-region]:not([data-drag-region="false"])';
    expect(element.querySelector(`app-browser ${dragRegion}, .tab-list${dragRegion}`)).toBeNull();

    await doubleClick('.toolbar');
    await doubleClick('.bookmarks__empty');
    await doubleClick('.tab-list');
    expect(windows.maximizeToggles).toBe(3);

    await doubleClick('.toolbar__button');
    await doubleClick('#omnibox');
    await doubleClick('.tab__title');
    expect(windows.maximizeToggles).toBe(3);
  });

  it('should open a new tab on Ctrl+T in any keyboard layout', async () => {
    // Українська розкладка: клавіша T дає «е», але code лишається KeyT.
    await press({ key: 'е', code: 'KeyT' });

    expect(tabs().length).toBe(2);
    expect(activeIndex()).toBe(1);
  });

  it('should switch tabs with Ctrl+Tab and Ctrl+Shift+Tab, going round', async () => {
    await openTab();
    await openTab();
    expect(activeIndex()).toBe(2);

    const tab = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', ctrlKey: true, cancelable: true });
    document.dispatchEvent(tab);
    await fixture.whenStable();
    expect(tab.defaultPrevented).toBe(true);
    expect(activeIndex()).toBe(0);

    await press({ key: 'Tab', code: 'Tab' });
    expect(activeIndex()).toBe(1);

    await press({ key: 'Tab', code: 'Tab', shiftKey: true });
    await press({ key: 'Tab', code: 'Tab', shiftKey: true });
    expect(activeIndex()).toBe(2);
  });

  it('should open a new and a private window from shortcuts', async () => {
    await press({ key: 'т', code: 'KeyN' });
    await press({ key: 'Т', code: 'KeyN', shiftKey: true });
    await press({ key: 'т', code: 'KeyN', altKey: true });

    expect(windows.opened).toEqual([false, true]);
  });

  it('should open a new and a private window from the menu', async () => {
    await click(menuItem('Нове вікно'));
    await click(menuItem('Приватне вікно'));

    expect(windows.opened).toEqual([false, true]);
  });

  it('should scale the page content with the menu zoom', async () => {
    await click(element.querySelector<HTMLButtonElement>('[aria-label="Збільшити масштаб"]'));

    expect(element.querySelector<HTMLElement>('.content')?.style.zoom).toBe('1.1');
  });

  it('should sign out from the profile menu only', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    expect(menuItem('Вийти')).toBeUndefined();

    await click(element.querySelector<HTMLButtonElement>('.profile-menu__sign-out'));

    expect(navigate).toHaveBeenCalledWith(['/sign-in']);
  });

  describe('internal pages', () => {
    const titles = () => [...element.querySelectorAll('.tab__title')].map((title) => title.textContent?.trim());
    const omnibox = () => element.querySelector<HTMLInputElement>('#omnibox')?.value;
    const tool = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('.tools-menu__tile')].find((tile) => tile.textContent?.includes(label));

    it('should open a page in the empty new tab and show its address', async () => {
      await click(menuItem('Історія'));

      expect(titles()).toEqual(['Історія']);
      expect(omnibox()).toBe('astra://history');
      expect(element.querySelector('app-history-page')).toBeTruthy();
      expect(element.querySelector('app-new-tab')).toBeNull();
    });

    it('should switch to an already open page instead of opening it again', async () => {
      await click(menuItem('Історія'));
      await openTab();
      await click(tool('Історія'));

      expect(titles()).toEqual(['Історія', 'Нова вкладка']);
      expect(activeIndex()).toBe(0);
    });

    it('should open downloads in a new tab on Ctrl+J when the current tab is busy', async () => {
      await click(menuItem('Закладки'));
      await press({ key: 'о', code: 'KeyJ' });

      expect(titles()).toEqual(['Закладки', 'Завантаження']);
      expect(activeIndex()).toBe(1);
      expect(omnibox()).toBe('astra://downloads');
      expect(element.querySelector('app-downloads-page')).toBeTruthy();
    });

    it('should show saved bookmarks on the bar and open internal pages from it', async () => {
      const bookmarks = TestBed.inject(BookmarksStore);
      bookmarks.add('YouTube', 'https://www.youtube.com/');
      bookmarks.add('Історія', 'astra://history');
      await fixture.whenStable();

      const bar = [...element.querySelectorAll<HTMLButtonElement>('.bookmark')];
      expect(bar.map((bookmark) => bookmark.textContent?.trim())).toEqual(['YouTube', 'Історія']);
      expect(element.querySelector('.bookmarks__empty')).toBeNull();

      await click(bar[1]);
      expect(titles()).toEqual(['Історія']);
    });

    it('should fill the star when the current page is bookmarked', async () => {
      const star = () => element.querySelector<HTMLButtonElement>('.omnibox__action');
      await click(menuItem('Історія'));
      expect(star()?.getAttribute('aria-label')).toBe('Додати сторінку в закладки');

      TestBed.inject(BookmarksStore).add('Історія', 'astra://history');
      await fixture.whenStable();

      expect(star()?.getAttribute('aria-label')).toBe('Редагувати закладку');
      expect(star()?.classList).toContain('omnibox__action--active');
    });

    it('should open settings, extensions and help pages from the menu', async () => {
      await click(menuItem('Налаштування'));
      expect(element.querySelector('app-settings-page')).toBeTruthy();

      await click(menuItem('Розширення'));
      expect(element.querySelector('app-extensions-page')).toBeTruthy();

      await click(menuItem('Довідка'));
      expect(element.querySelector('app-help-page')).toBeTruthy();
      expect(titles()).toEqual(['Налаштування', 'Розширення', 'Довідка']);
    });

    it('should hide the bookmarks bar when it is turned off in settings', async () => {
      await click(menuItem('Налаштування'));
      await click(element.querySelector<HTMLInputElement>('#settings-bookmarks-bar'));

      expect(element.querySelector('.bookmarks')).toBeNull();
    });
  });

  describe('find and print', () => {
    it('should open the find bar on Ctrl+F and close it with Escape', async () => {
      await press({ key: 'а', code: 'KeyF' });
      const input = element.querySelector<HTMLInputElement>('#find-on-page');
      expect(input).toBeTruthy();
      expect(document.activeElement).toBe(input);

      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await fixture.whenStable();
      expect(element.querySelector('app-find-bar')).toBeNull();
    });

    it('should search only the current page and close when the tab changes', async () => {
      await click(menuItem('Знайти на сторінці'));
      const input = element.querySelector<HTMLInputElement>('#find-on-page') as HTMLInputElement;
      input.value = 'browser';
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();

      // «Astra Browser» на новій вкладці — один збіг: шукаємо лише у вмісті сторінки, а не в меню чи вкладках.
      expect(element.querySelector('.find-bar__status')?.textContent?.trim()).toBe('1 / 1');

      await openTab();
      expect(element.querySelector('app-find-bar')).toBeNull();
    });

    it('should print on Ctrl+P and from the menu', async () => {
      const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);

      await press({ key: 'з', code: 'KeyP' });
      await click(menuItem('Друк'));

      expect(print).toHaveBeenCalledTimes(2);
    });
  });
});
