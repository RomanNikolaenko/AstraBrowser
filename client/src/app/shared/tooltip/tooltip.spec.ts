import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Tooltip } from './tooltip';

@Component({
  imports: [Tooltip],
  template: `<button type="button" [appTooltip]="title" [tooltipDetail]="url">{{ title }}</button>`,
})
class Host {
  title = 'Counter-Strike News & Coverage | HLTV.org';
  url = 'https://www.hltv.org/';
}

describe('Tooltip', () => {
  afterEach(() => vi.useRealTimers());

  it('should show the whole text after a pause and hide it when the pointer leaves', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const button = (fixture.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;
    const tooltip = () => document.body.querySelector('.app-tooltip');

    button.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(300);
    expect(tooltip()).toBeNull();
    vi.advanceTimersByTime(300);
    expect(tooltip()?.getAttribute('role')).toBe('tooltip');
    expect([...(tooltip()?.children ?? [])].map((line) => line.textContent)).toEqual([
      'Counter-Strike News & Coverage | HLTV.org',
      'https://www.hltv.org/',
    ]);

    button.dispatchEvent(new MouseEvent('mouseleave'));
    expect(tooltip()).toBeNull();

    // Клік до кінця паузи — підказки так і не буде.
    button.dispatchEvent(new MouseEvent('mouseenter'));
    button.dispatchEvent(new MouseEvent('mousedown'));
    vi.advanceTimersByTime(1000);
    expect(tooltip()).toBeNull();
  });
});
