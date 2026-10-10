import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { UiSelect, UiSelectOption } from '../../shared/ui-select/ui-select';
import { AutoplayChoice, AutoplayStore } from '../data/autoplay';
import { PERMISSION_INFO, PermissionKind, PermissionState, PermissionsStore } from '../data/permissions';
import { PageViews } from '../page-views/page-views';
import { Popover } from '../popover/popover';

/** Дозволи, які видно на панелі (решту сайт попросить, коли знадобиться, — тоді й з'явиться запитання). */
const SHOWN: readonly PermissionKind[] = ['camera', 'microphone', 'location', 'notifications', 'clipboard'];

/**
 * Панель дозволів сайту з кнопки на початку адресного рядка: камера, мікрофон, геолокація, сповіщення, буфер
 * обміну — їх зберігає профіль WebView2 для origin сторінки, тож вони діють у всіх вкладках сайту; спливні вікна
 * й автовідтворення — свої правила браузера.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, UiIcon, UiSelect],
  selector: 'app-site-permissions',
  styleUrl: './site-permissions.scss',
  templateUrl: './site-permissions.html',
})
export class SitePermissions {
  /** Webview сайту, дозволи якого показуються. */
  readonly page = input.required<string>();
  readonly pageUrl = input.required<string>();

  private readonly pageViews = inject(PageViews);
  private readonly autoplayRules = inject(AutoplayStore);
  private readonly permissionsStore = inject(PermissionsStore);

  private readonly origin = computed(() => {
    try {
      return new URL(this.pageUrl()).origin;
    } catch {
      return '';
    }
  });
  protected readonly host = computed(() => {
    try {
      return new URL(this.pageUrl()).host;
    } catch {
      return this.pageUrl();
    }
  });

  /** Збережені дозволи сайту; null — ще читаються. */
  protected readonly permissions = signal<Readonly<Record<string, PermissionState>> | null>(null);
  protected readonly rows = SHOWN.map((kind) => ({ kind, ...PERMISSION_INFO[kind] }));
  protected readonly popupsAllowed = computed(() => this.permissionsStore.popupsAllowed(this.origin()));
  /** null — дозвіл ще читається. */
  protected readonly autoplay = signal<AutoplayChoice | null>(null);
  /** Дозвіл змінено, а сторінка ще працює зі старим. */
  protected readonly changed = signal(false);

  protected readonly states: readonly UiSelectOption<PermissionState>[] = [
    { value: 'ask', label: 'Питати' },
    { value: 'allow', label: 'Дозволити' },
    { value: 'deny', label: 'Блокувати' },
  ];
  protected readonly popupChoices: readonly UiSelectOption<'allow' | 'deny'>[] = [
    { value: 'deny', label: 'Блокувати' },
    { value: 'allow', label: 'Дозволити' },
  ];
  // Обидві заборони — наш скрипт сторінки (server/src/audio.rs); «Блокувати аудіо та відео» ще й забороняє WebView2.
  protected readonly choices: readonly UiSelectOption<AutoplayChoice>[] = [
    { value: 'allow', label: 'Дозволити аудіо та відео' },
    { value: 'block-audio', label: 'Блокувати аудіо' },
    { value: 'block', label: 'Блокувати аудіо та відео' },
  ];

  private readonly popover = viewChild.required(Popover);

  constructor() {
    // Панель про конкретний сайт: інша вкладка чи інший сайт — закриваємо.
    effect(() => {
      this.page();
      this.host();
      untracked(() => {
        if (this.popover().isOpen()) {
          this.popover().hide();
        }
      });
    });
  }

  protected async onOpened(): Promise<void> {
    this.changed.set(false);
    this.autoplay.set(null);
    this.permissions.set(null);
    const [permission, saved] = await Promise.all([
      this.pageViews.autoplay(this.page()).catch(() => 'default'),
      this.pageViews.permissions(this.page()).catch(() => ({})),
    ]);
    this.permissions.set(saved);
    // За замовчуванням — «Блокувати аудіо та відео»; дозволене — лише те, що дозволив сам користувач. Сайтам,
    // яким дозволили ще до наших правил (лише в WebView2), дозвіл переходить і в правила.
    let choice = this.autoplayRules.choiceFor(this.origin());
    if (choice === 'block' && permission === 'allow') {
      choice = 'allow';
      this.autoplayRules.setChoice(this.origin(), choice);
    }
    this.autoplay.set(choice);
  }

  protected stateOf(kind: PermissionKind): PermissionState {
    return this.permissions()?.[kind] ?? 'ask';
  }

  protected async setPermission(kind: PermissionKind, state: PermissionState | undefined): Promise<void> {
    const previous = this.permissions();
    if (!state || !previous) {
      return;
    }
    this.permissions.set({ ...previous, [kind]: state });
    try {
      await this.pageViews.setPermission(this.page(), kind, state);
      this.changed.set(true);
    } catch {
      this.permissions.set(previous);
    }
  }

  protected setPopups(choice: 'allow' | 'deny' | undefined): void {
    if (choice) {
      this.permissionsStore.setPopupsAllowed(this.origin(), choice === 'allow');
    }
  }

  protected async setAutoplay(choice: AutoplayChoice | undefined): Promise<void> {
    if (!choice) {
      return;
    }
    const previous = this.autoplay();
    this.autoplay.set(choice);
    try {
      // «Блокувати аудіо» — відео дозволене WebView2, а звук глушить наш скрипт (server/src/audio.rs).
      await this.pageViews.setAutoplay(this.page(), choice === 'block' ? 'block' : 'allow');
      this.autoplayRules.setChoice(this.origin(), choice);
      this.changed.set(true);
    } catch {
      this.autoplay.set(previous);
    }
  }

  protected reload(): void {
    this.popover().hide();
    void this.pageViews.reload(this.page()).catch(() => undefined);
  }
}
