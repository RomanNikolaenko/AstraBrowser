import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslatePipe } from '../../shared/i18n/i18n';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { AddressesStore, AutofillKind, addressLine, addressValue, fullName } from '../data/addresses';
import type { PageBounds } from '../page-views/page-views';

/** Пункт списку: що адреса дасть полю і чим вона ще впізнавана. */
interface Suggestion {
  readonly id: string;
  readonly value: string;
  readonly detail: string;
}

/** Відступ списку від поля й від країв вікна, px. */
const GAP = 4;
const EDGE = 8;
/** Ширина списку — як у поля, але не вужча й не ширша за це, px. */
const MIN_WIDTH = 260;
const MAX_WIDTH = 420;
/** Скільки після втрати фокусу сайтом чекати, чи фокус прийшов в інтерфейс (клік у список), мс. */
const BLUR_CHECK_MS = 150;

/**
 * Збережені адреси над полем форми на сайті (server/src/addresses.rs, autofill-page.js). Список малює інтерфейс, а не
 * сторінка: сайт адрес не бачить, доки користувач не вибрав одну. Фокус лишається в полі сайту, тож стрілки, Enter
 * і Esc приходять від сторінки (`key`). Вибрали адресу — сторінка заповнює нею форму (AddressesStore.fill).
 *
 * Показує, зсуває й ховає список браузер (page://autofill): `show`, `move`, `hide`, `blur`. Поле — у фізичних
 * пікселях від кута сайту, а сайт — у межах `page` (координати вікна).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, UiIcon],
  selector: 'app-autofill-popup',
  styleUrl: './autofill-popup.scss',
  templateUrl: './autofill-popup.html',
})
export class AutofillPopup {
  private readonly addresses = inject(AddressesStore);
  private readonly changes = inject(ChangeDetectorRef);

  /** «Керувати адресами…». */
  readonly manage = output<void>();
  /** Список став деінде: регіон інтерфейсу над сайтом треба оновити. */
  readonly moved = output<void>();

  /** Сайт, над полем якого показано список; null — список сховано. */
  protected readonly label = signal<string | null>(null);
  private readonly kind = signal<AutofillKind>('name');
  private readonly ids = signal<readonly string[]>([]);
  /** Вибраний стрілками пункт; дорівнює кількості адрес — «Керувати адресами…». */
  protected readonly selected = signal(-1);
  protected readonly suggestions = computed<Suggestion[]>(() => {
    const kind = this.kind();
    const entries = this.addresses.entries();
    return this.ids().flatMap((id) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) {
        return [];
      }
      const value = addressValue(entry.fields, kind);
      const others = [
        fullName(entry.fields) || entry.fields.organization.trim(),
        addressLine(entry.fields),
        entry.fields.phone.trim(),
        entry.fields.email.trim(),
      ];
      return value ? [{ id, value, detail: others.find((other) => other && other !== value) ?? '' }] : [];
    });
  });

  private readonly panel = viewChild.required<ElementRef<HTMLElement>>('panel');
  private field: PageBounds | null = null;
  private page: PageBounds | null = null;
  private blurTimer: ReturnType<typeof setTimeout> | undefined;
  /** Чи список зараз у top layer (showPopover). */
  private opened = false;

  constructor() {
    // Клік в інтерфейсі повз список — список ховається (клік по сайту сховає його сторінка).
    const onPointerDown = (event: PointerEvent) => {
      if (this.label() && !this.panel().nativeElement.contains(event.target as Node)) {
        this.hide();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      clearTimeout(this.blurTimer);
    });
  }

  show(label: string, kind: AutofillKind, ids: readonly string[], field: PageBounds, page: PageBounds): void {
    clearTimeout(this.blurTimer);
    this.label.set(label);
    this.kind.set(kind);
    this.ids.set(ids);
    this.selected.set(-1);
    if (!this.suggestions().length) {
      this.hide();
      return;
    }
    this.field = field;
    this.page = page;
    // Вміст — одразу, щоб виміряти список і поставити його над полем чи під ним.
    this.changes.detectChanges();
    if (!this.opened) {
      this.panel().nativeElement.showPopover?.();
      this.opened = true;
    }
    this.place();
  }

  /** Поле зсунулося (сайт прокрутили) — список за ним. */
  move(label: string, field: PageBounds, page: PageBounds): void {
    if (label === this.label()) {
      this.field = field;
      this.page = page;
      this.place();
    }
  }

  /** Сховати список (лише сайту `label`, якщо його задано). */
  hide(label?: string): void {
    if (label !== undefined && label !== this.label()) {
      return;
    }
    clearTimeout(this.blurTimer);
    this.label.set(null);
    this.selected.set(-1);
    if (this.opened) {
      this.panel().nativeElement.hidePopover?.();
      this.opened = false;
    }
  }

  /** Сайт утратив фокус: якщо не через клік у список (тоді фокус в інтерфейсі) — інша програма, і список ховається. */
  blur(label: string): void {
    if (label !== this.label()) {
      return;
    }
    clearTimeout(this.blurTimer);
    this.blurTimer = setTimeout(() => {
      if (!document.hasFocus()) {
        this.hide();
      }
    }, BLUR_CHECK_MS);
  }

  /** Клавіша в полі сайту, поки список відкритий: стрілки ходять пунктами, Enter вибирає, Esc ховає. */
  key(label: string, key: string | undefined): void {
    if (label !== this.label()) {
      return;
    }
    const count = this.suggestions().length + 1;
    const selected = this.selected();
    switch (key) {
      case 'ArrowDown':
        this.selected.set((selected + 1) % count);
        break;
      case 'ArrowUp':
        this.selected.set(selected <= 0 ? count - 1 : selected - 1);
        break;
      case 'Enter':
        if (selected === count - 1) {
          this.openManage();
        } else if (selected >= 0) {
          this.pick(selected);
        }
        break;
      case 'Escape':
        this.hide();
        break;
    }
  }

  protected pick(index: number): void {
    const label = this.label();
    const suggestion = this.suggestions()[index];
    this.hide();
    if (label && suggestion) {
      void this.addresses.fill(label, suggestion.id).catch(() => undefined);
    }
  }

  protected openManage(): void {
    this.hide();
    this.manage.emit();
  }

  /**
   * Під полем, а як там не вміщається — над ним; не за краями вікна. Поле, що пішло з видимої частини сайту, ховає
   * список. Місце для регіону інтерфейсу (data-layer-margins) — разом із тінню, але без поля: клік у нього — сайтові.
   */
  private place(): void {
    const { field, page } = this;
    if (!field || !page || !this.label()) {
      return;
    }
    const ratio = window.devicePixelRatio || 1;
    const left = page.x + field.x / ratio;
    const top = page.y + field.y / ratio;
    const width = field.width / ratio;
    const bottom = top + field.height / ratio;
    if (bottom < page.y || top > page.y + page.height || left + width < page.x || left > page.x + page.width) {
      this.hide();
      return;
    }
    const panel = this.panel().nativeElement;
    panel.style.minWidth = `${Math.min(Math.max(width, MIN_WIDTH), MAX_WIDTH)}px`;
    const box = panel.getBoundingClientRect();
    const below = bottom + GAP + box.height <= window.innerHeight - EDGE || top - GAP - box.height < EDGE;
    panel.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - box.width - EDGE))}px`;
    panel.style.top = `${below ? bottom + GAP : top - GAP - box.height}px`;
    // Тінь — переважно донизу (autofill-popup.scss); з боку поля — ані пікселя поверх нього.
    panel.dataset['layerMargins'] = JSON.stringify(below ? [GAP, 24, 32, 24] : [24, 24, GAP, 24]);
    this.moved.emit();
  }
}
