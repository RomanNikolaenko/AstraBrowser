import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ZoomBadge } from './zoom-badge';

@Component({
  imports: [ZoomBadge],
  template: `<app-zoom-badge [(zoom)]="zoom" />`,
})
class Host {
  readonly zoom = signal(100);
}

describe('ZoomBadge', () => {
  const setup = async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const badge = () => element.querySelector('.zoom-badge') as HTMLButtonElement | null;
    const click = async (label: string) => {
      element.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.click();
      await fixture.whenStable();
    };
    return { fixture, host: fixture.componentInstance, element, badge, click };
  };

  it('should show the zoom only when it is not 100%', async () => {
    const { fixture, host, badge } = await setup();
    expect(badge()).toBeNull();

    host.zoom.set(90);
    await fixture.whenStable();
    expect(badge()?.textContent?.trim()).toBe('90%');
    expect(badge()?.getAttribute('popovertarget')).toBe('zoom-popover');
    expect(badge()?.title).toBe('Масштаб 90%');
  });

  it('should step the zoom and reset it from its panel', async () => {
    const { fixture, host, element, badge, click } = await setup();
    host.zoom.set(90);
    await fixture.whenStable();

    await click('Збільшити масштаб');
    expect(host.zoom()).toBe(100);
    await click('Збільшити масштаб');
    expect(host.zoom()).toBe(110);
    expect(element.querySelector('.zoom-popover__value')?.textContent).toBe('110%');
    await click('Зменшити масштаб');
    await click('Зменшити масштаб');
    expect(host.zoom()).toBe(90);

    element.querySelector<HTMLButtonElement>('.zoom-popover__reset')?.click();
    await fixture.whenStable();
    expect(host.zoom()).toBe(100);
    expect(badge()).toBeNull();
  });

  it('should stop at the smallest and the largest zoom', async () => {
    const { fixture, host, element } = await setup();
    host.zoom.set(25);
    await fixture.whenStable();
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Зменшити масштаб"]')?.disabled).toBe(true);

    host.zoom.set(500);
    await fixture.whenStable();
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Збільшити масштаб"]')?.disabled).toBe(true);
  });
});
