import { Directive, ElementRef, OnDestroy, inject, input } from '@angular/core';

/** Скільки тримати курсор над елементом, поки з'явиться підказка. */
const SHOW_DELAY = 500;
/** Відступ підказки від елемента й від країв вікна. */
const GAP = 6;

/**
 * Підказка з повним текстом при наведенні — замість системної (title): у стилі застосунку й поверх усього,
 * зокрема над сайтом (це popover у top layer, і Browser вирізає під нього отвір у сайті).
 * `appTooltip` — головний рядок, `tooltipDetail` — другий, дрібніший (адреса тощо). Порожньо — підказки немає.
 * Стилі — .app-tooltip у styles.scss: сама підказка живе в <body>, поза компонентом.
 */
@Directive({
  selector: '[appTooltip]',
  host: {
    '(mouseenter)': 'schedule()',
    '(mouseleave)': 'hide()',
    '(mousedown)': 'hide()',
    '(dragstart)': 'hide()',
    '(focusout)': 'hide()',
  },
})
export class Tooltip implements OnDestroy {
  readonly appTooltip = input('');
  readonly tooltipDetail = input('');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private bubble: HTMLElement | null = null;

  ngOnDestroy(): void {
    this.hide();
  }

  protected schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.show(), SHOW_DELAY);
  }

  protected hide(): void {
    clearTimeout(this.timer);
    if (this.bubble?.matches(':popover-open')) {
      this.bubble.hidePopover();
    }
    this.bubble?.remove();
    this.bubble = null;
  }

  private show(): void {
    const lines = [
      ['app-tooltip__text', this.appTooltip().trim()],
      ['app-tooltip__detail', this.tooltipDetail().trim()],
    ].filter(([, text]) => text);
    const host = this.host.nativeElement;
    if (!lines.length || !host.isConnected) {
      return;
    }
    this.hide();
    const bubble = document.createElement('div');
    bubble.className = 'app-tooltip';
    bubble.setAttribute('popover', 'manual');
    bubble.setAttribute('role', 'tooltip');
    for (const [className, text] of lines) {
      const line = document.createElement('span');
      line.className = className;
      line.textContent = text;
      bubble.append(line);
    }
    document.body.append(bubble);
    bubble.showPopover?.();
    this.bubble = bubble;
    this.place(bubble, host.getBoundingClientRect());
  }

  /** Під елементом, від його лівого краю; не вміщається — лівіше чи над ним. */
  private place(bubble: HTMLElement, anchor: DOMRect): void {
    const { offsetWidth: width, offsetHeight: height } = bubble;
    const left = Math.max(GAP, Math.min(anchor.left, window.innerWidth - width - GAP));
    const below = anchor.bottom + GAP;
    const top = below + height <= window.innerHeight - GAP ? below : Math.max(GAP, anchor.top - height - GAP);
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;
  }
}
