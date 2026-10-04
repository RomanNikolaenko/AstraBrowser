import { WheelZoom, canZoomIn, canZoomOut, zoomIn, zoomOut } from './zoom';

describe('zoom', () => {
  it('should step through the Chrome zoom levels and stop at their ends', () => {
    expect(zoomIn(100)).toBe(110);
    expect(zoomOut(100)).toBe(90);
    expect(zoomIn(500)).toBe(500);
    expect(zoomOut(25)).toBe(25);
    expect(canZoomIn(500)).toBe(false);
    expect(canZoomOut(25)).toBe(false);
  });

  it('should take one step per wheel click and gather small touchpad scrolls', () => {
    const wheel = new WheelZoom();

    // Клацання коліщатка вгору — більше, вниз — менше.
    expect(wheel.apply(100, -100, 0)).toBe(110);
    expect(wheel.apply(110, 100, 50)).toBe(100);

    // Тачпад: дрібні прокрутки збираються до кроку.
    expect(wheel.apply(100, -20, 100)).toBe(100);
    expect(wheel.apply(100, -20, 150)).toBe(100);
    expect(wheel.apply(100, -20, 200)).toBe(110);

    // Після паузи накопичене забувається.
    expect(wheel.apply(110, -30, 300)).toBe(110);
    expect(wheel.apply(110, -30, 1000)).toBe(110);
  });
});
