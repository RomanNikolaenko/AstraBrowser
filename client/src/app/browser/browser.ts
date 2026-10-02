import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BrowserWindows } from '../shared/browser-windows/browser-windows';
import { SettingsStore } from '../shared/settings/settings';
import { UiIcon } from '../shared/ui-icon/ui-icon';
import { UiInput } from '../shared/ui-input/ui-input';
import { TitlebarContent } from '../shared/titlebar/titlebar-content';
import { BrowserMenu } from './browser-menu/browser-menu';
import { BookmarksStore, bookmarkIcon } from './data/bookmarks';
import { FindBar } from './find-bar/find-bar';
import { NewTab } from './new-tab/new-tab';
import { BookmarksPage } from './pages/bookmarks-page/bookmarks-page';
import { DownloadsPage } from './pages/downloads-page/downloads-page';
import { ExtensionsPage } from './pages/extensions-page/extensions-page';
import { HelpPage } from './pages/help-page/help-page';
import { HistoryPage } from './pages/history-page/history-page';
import { InternalPage, TAB_PAGES, TabPage } from './pages/internal-pages';
import { SettingsPage } from './pages/settings-page/settings-page';
import { ProfileMenu } from './profile-menu/profile-menu';
import { ToolsMenu } from './tools-menu/tools-menu';

interface BrowserTab {
  readonly id: number;
  readonly page: TabPage;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    BookmarksPage,
    BrowserMenu,
    DownloadsPage,
    ExtensionsPage,
    FindBar,
    HelpPage,
    HistoryPage,
    NewTab,
    ProfileMenu,
    SettingsPage,
    TitlebarContent,
    ToolsMenu,
    UiIcon,
    UiInput,
  ],
  selector: 'app-browser',
  styleUrl: './browser.scss',
  templateUrl: './browser.html',
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class Browser {
  private readonly router = inject(Router);
  private readonly windows = inject(BrowserWindows);

  protected readonly settings = inject(SettingsStore);
  protected readonly bookmarks = inject(BookmarksStore);
  protected readonly bookmarkIcon = bookmarkIcon;
  protected readonly pages = TAB_PAGES;

  protected readonly tabs = signal<readonly BrowserTab[]>([{ id: 1, page: 'new-tab' }]);

  protected readonly activeTabId = signal(1);

  // Вкладок завжди щонайменше одна: closeTab замінює останню новою.
  protected readonly activeTab = computed(() => {
    const tabs = this.tabs();
    return tabs.find((tab) => tab.id === this.activeTabId()) ?? tabs[0];
  });

  /** Масштаб вмісту сторінки у відсотках; змінюється в головному меню. */
  protected readonly zoom = signal(100);

  /** Панель «Знайти на сторінці» шукає в поточній сторінці, тож закривається, щойно сторінка інша. */
  protected readonly findOpen = signal(false);
  private readonly findBar = viewChild(FindBar);

  private nextTabId = 2;

  constructor() {
    effect(() => {
      this.activeTab();
      untracked(() => this.findOpen.set(false));
    });
  }

  protected selectTab(id: number): void {
    this.activeTabId.set(id);
  }

  protected openNewTab(): void {
    const tab = this.createNewTab();
    this.tabs.update((tabs) => [...tabs, tab]);
    this.activeTabId.set(tab.id);
  }

  protected closeTab(id: number): void {
    const tabs = this.tabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index === -1) {
      return;
    }

    const remaining = tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0) {
      const tab = this.createNewTab();
      this.tabs.set([tab]);
      this.activeTabId.set(tab.id);
      return;
    }

    this.tabs.set(remaining);
    if (id === this.activeTabId()) {
      // Як у Chrome: активною стає вкладка праворуч, а якщо її немає — ліворуч.
      this.activeTabId.set(remaining[Math.min(index, remaining.length - 1)].id);
    }
  }

  // Справжньої сесії ще немає: вихід просто повертає на сторінку входу.
  protected signOut(): void {
    void this.router.navigate(['/sign-in']);
  }

  protected async toggleFullscreen(): Promise<void> {
    if (isTauri()) {
      const window = getCurrentWindow();
      await window.setFullscreen(!(await window.isFullscreen()));
      return;
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  }

  /**
   * Як у Chrome: якщо сторінка вже відкрита — перейти на її вкладку; якщо поточна вкладка порожня —
   * відкрити сторінку в ній; інакше — у новій вкладці.
   */
  protected openPage(page: InternalPage): void {
    const existing = this.tabs().find((tab) => tab.page === page);
    if (existing) {
      this.activeTabId.set(existing.id);
      return;
    }

    const active = this.activeTab();
    if (active.page === 'new-tab') {
      this.tabs.update((tabs) => tabs.map((tab) => (tab.id === active.id ? { ...tab, page } : tab)));
      return;
    }

    const tab: BrowserTab = { id: this.nextTabId++, page };
    this.tabs.update((tabs) => [...tabs, tab]);
    this.activeTabId.set(tab.id);
  }

  protected openWindow(isPrivate = false): void {
    this.windows.open({ private: isPrivate });
  }

  /** Повторне Ctrl+F при відкритій панелі лише повертає фокус у поле й виділяє запит. */
  protected openFind(): void {
    const findBar = this.findBar();
    if (findBar) {
      findBar.focus();
    } else {
      this.findOpen.set(true);
    }
  }

  // Стилі @media print у styles.scss лишають на папері тільки вміст сторінки.
  protected print(): void {
    window.print();
  }

  // event.code, а не key: з українською розкладкою клавіша T дає «е», а N — «т».
  protected onKeydown(event: KeyboardEvent): void {
    if (!event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }

    switch ((event.shiftKey ? 'Shift+' : '') + event.code) {
      case 'KeyT':
        this.openNewTab();
        break;
      case 'KeyN':
        this.openWindow();
        break;
      case 'Shift+KeyN':
        this.openWindow(true);
        break;
      case 'KeyJ':
        this.openPage('downloads');
        break;
      case 'KeyF':
        this.openFind();
        break;
      case 'KeyP':
        this.print();
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  private createNewTab(): BrowserTab {
    return { id: this.nextTabId++, page: 'new-tab' };
  }
}
