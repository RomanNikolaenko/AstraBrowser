import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BrowserWindows } from '../browser-windows/browser-windows';
import { Titlebar } from './titlebar';
import { TitlebarContent } from './titlebar-content';

@Component({
  imports: [Titlebar, TitlebarContent],
  template: `
    <app-titlebar />
    @if (showContent()) {
      <ng-template appTitlebarContent (spacerMiddleClick)="spacerMiddleClicks.set(spacerMiddleClicks() + 1)"><span class="screen-content">{{ label() }}</span></ng-template>
    }
  `,
})
class Host {
  readonly showContent = signal(false);
  readonly label = signal('Вкладки');
  readonly spacerMiddleClicks = signal(0);
}

describe('Titlebar', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    return { fixture, titlebar: (fixture.nativeElement as HTMLElement).querySelector('.titlebar') as HTMLElement };
  };

  it('should render the app title and window controls by default', async () => {
    const { titlebar } = await setup();

    expect(titlebar.querySelector('.titlebar__title')?.textContent).toContain('Astra Browser');
    expect(titlebar.querySelectorAll('.window-control').length).toBe(3);
  });

  it('should mark a private window only', async () => {
    const { titlebar } = await setup();
    expect(titlebar.querySelector('.titlebar__private')).toBeNull();

    TestBed.resetTestingModule();
    TestBed.overrideProvider(BrowserWindows, { useValue: { isPrivate: true } });
    const privateWindow = await setup();
    expect(privateWindow.titlebar.querySelector('.titlebar__private')?.textContent).toContain('Приватне вікно');
  });

  it('should show screen content instead of the title while the screen is open', async () => {
    const { fixture, titlebar } = await setup();

    fixture.componentInstance.showContent.set(true);
    await fixture.whenStable();
    expect(titlebar.querySelector('.screen-content')?.textContent).toBe('Вкладки');
    expect(titlebar.querySelector('.titlebar__title')).toBeNull();

    fixture.componentInstance.label.set('Оновлено');
    await fixture.whenStable();
    expect(titlebar.querySelector('.screen-content')?.textContent).toBe('Оновлено');

    fixture.componentInstance.showContent.set(false);
    await fixture.whenStable();
    expect(titlebar.querySelector('.screen-content')).toBeNull();
    expect(titlebar.querySelector('.titlebar__title')).toBeTruthy();
  });

  it('should pass a middle click on the free space to the open screen only', async () => {
    const { fixture, titlebar } = await setup();
    const middleClick = () => titlebar.querySelector('.titlebar__spacer')?.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));

    middleClick();
    expect(fixture.componentInstance.spacerMiddleClicks()).toBe(0);

    fixture.componentInstance.showContent.set(true);
    await fixture.whenStable();
    middleClick();
    expect(fixture.componentInstance.spacerMiddleClicks()).toBe(1);
  });
});
