import { Directive, output } from '@angular/core';

/** Клік середньою кнопкою (коліщатком) миші: `(appMiddleClick)="…"`. */
@Directive({
  selector: '[appMiddleClick]',
  host: {
    '(mousedown)': 'preventAutoscroll($event)',
    '(auxclick)': 'onAuxClick($event)',
  },
})
export class MiddleClick {
  readonly appMiddleClick = output<MouseEvent>();

  // Інакше Chromium (WebView2) на натисканні коліщатка вмикає автопрокрутку й переводить фокус.
  protected preventAutoscroll(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
    }
  }

  protected onAuxClick(event: MouseEvent): void {
    if (event.button === 1) {
      event.preventDefault();
      this.appMiddleClick.emit(event);
    }
  }
}
