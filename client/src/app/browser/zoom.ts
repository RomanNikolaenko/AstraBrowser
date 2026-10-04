/** Кроки масштабу сторінки, ті самі, що й у Chrome (у відсотках). */
export const ZOOM_LEVELS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500] as const;

/** Масштаб за замовчуванням. */
export const DEFAULT_ZOOM = 100;

/** Наступний більший крок (на найбільшому — той самий). */
export function zoomIn(zoom: number): number {
  return ZOOM_LEVELS.find((level) => level > zoom) ?? zoom;
}

/** Наступний менший крок (на найменшому — той самий). */
export function zoomOut(zoom: number): number {
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom) ?? zoom;
}

export function canZoomIn(zoom: number): boolean {
  return zoom < ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}

export function canZoomOut(zoom: number): boolean {
  return zoom > ZOOM_LEVELS[0];
}

/** Скільки прокрутки з Ctrl — один крок масштабу (клацання коліщатка — близько 100) і через скільки мс накопичене забувається. */
const WHEEL_STEP = 50;
const WHEEL_IDLE = 400;

/**
 * Ctrl + коліщатко: крок масштабу на кожне клацання коліщатка. Тачпад (і щипок на ньому) дає дрібні прокрутки —
 * вони накопичуються до кроку, щоб масштаб не проскакував усі рівні за мить. Те саме робить скрипт сайтів
 * (server/src/zoom-page.js).
 */
export class WheelZoom {
  private sum = 0;
  private last = 0;

  /** Новий масштаб після прокрутки `deltaY` (вгору — більше), чи той самий, поки кроку не набралося. */
  apply(zoom: number, deltaY: number, now = performance.now()): number {
    this.sum = now - this.last > WHEEL_IDLE ? deltaY : this.sum + deltaY;
    this.last = now;
    if (Math.abs(this.sum) < WHEEL_STEP) {
      return zoom;
    }
    const next = this.sum < 0 ? zoomIn(zoom) : zoomOut(zoom);
    this.sum = 0;
    return next;
  }
}
