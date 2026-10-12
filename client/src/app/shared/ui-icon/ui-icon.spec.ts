import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ICONS } from './icons';
import { UiIcon, iconMarkup } from './ui-icon';

@Component({
  imports: [UiIcon],
  template: `<app-icon [icon]="name()" />`,
})
class Host {
  readonly name = signal<string | undefined>('close');
}

/** Розмітка так, як її записує браузер (самозакриті теги стають парними). */
function parsed(markup: string): string {
  const box = document.createElement('div');
  box.innerHTML = markup;
  return box.innerHTML;
}

describe('UiIcon', () => {
  it('should draw the icon right away, without a request', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const icon = (fixture.nativeElement as HTMLElement).querySelector('app-icon') as HTMLElement;
    expect(icon.innerHTML).toBe(parsed(ICONS['close']));
    expect(icon.getAttribute('aria-hidden')).toBe('true');

    fixture.componentInstance.name.set('star');
    await fixture.whenStable();
    expect(icon.innerHTML).toBe(parsed(ICONS['star']));

    fixture.componentInstance.name.set(undefined);
    await fixture.whenStable();
    expect(icon.innerHTML).toBe('');
  });

  it('should report an unknown icon once and draw nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(iconMarkup('no-such-icon')).toBe('');
    expect(iconMarkup('no-such-icon')).toBe('');

    expect(error).toHaveBeenCalledTimes(1);
  });

  it('should bundle every icon as SVG markup', () => {
    expect(Object.keys(ICONS).length).toBeGreaterThan(50);
    for (const [name, svg] of Object.entries(ICONS)) {
      expect(svg.trim(), name).toMatch(/^<svg[\s>][\s\S]*<\/svg>$/);
    }
  });
});
