import { ChangeDetectionStrategy, Component, computed, signal } from '@angular/core';
import { UiIcon } from '../shared/ui-icon/ui-icon';
import { UiInput } from '../shared/ui-input/ui-input';
import { TitlebarContent } from '../shared/titlebar/titlebar-content';
import { NewTab } from './new-tab/new-tab';

interface BrowserTab {
  readonly id: number;
  readonly title: string;
  readonly favicon: string;
  /** `null` — сторінка «Нова вкладка». */
  readonly url: string | null;
}

interface Bookmark {
  readonly title: string;
  readonly favicon: string;
  readonly url?: string;
}

const NEW_TAB_TITLE = 'Нова вкладка';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NewTab, TitlebarContent, UiIcon, UiInput],
  selector: 'app-browser',
  styleUrl: './browser.scss',
  templateUrl: './browser.html',
})
export class Browser {
  // Демо-дані з макета, доки немає справжнього рушія сторінок і синхронізації закладок.
  protected readonly bookmarks: readonly Bookmark[] = [
    { title: 'Робота', favicon: 'favicon-folder' },
    { title: 'YouTube', favicon: 'favicon-youtube', url: 'https://www.youtube.com' },
    { title: 'GitHub', favicon: 'favicon-github', url: 'https://github.com' },
    { title: 'Figma', favicon: 'favicon-figma', url: 'https://www.figma.com' },
    { title: 'Пошта', favicon: 'favicon-mail', url: 'https://mail.google.com' },
    { title: 'Документи', favicon: 'favicon-docs', url: 'https://docs.google.com' },
  ];

  protected readonly tabs = signal<readonly BrowserTab[]>([
    { id: 1, title: NEW_TAB_TITLE, favicon: 'favicon-home', url: null },
    { id: 2, title: 'Product Ideas', favicon: 'favicon-document', url: 'https://notes.example.com/product-ideas' },
    { id: 3, title: 'Design Research', favicon: 'favicon-folder-violet', url: 'https://drive.example.com/design-research' },
    { id: 4, title: 'Travel Plans', favicon: 'favicon-travel', url: 'https://travel.example.com/plans' },
  ]);

  protected readonly activeTabId = signal(1);

  // Вкладок завжди щонайменше одна: closeTab замінює останню новою.
  protected readonly activeTab = computed(() => {
    const tabs = this.tabs();
    return tabs.find((tab) => tab.id === this.activeTabId()) ?? tabs[0];
  });

  private nextTabId = 5;

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

  private createNewTab(): BrowserTab {
    return { id: this.nextTabId++, title: NEW_TAB_TITLE, favicon: 'favicon-home', url: null };
  }
}
