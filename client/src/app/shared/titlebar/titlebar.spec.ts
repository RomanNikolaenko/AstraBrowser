import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Titlebar } from './titlebar';
import { TitlebarContent } from './titlebar-content';

@Component({
  imports: [Titlebar, TitlebarContent],
  template: `
    <app-titlebar />
    @if (showContent()) {
      <ng-template appTitlebarContent><span class="screen-content">{{ label() }}</span></ng-template>
    }
  `,
})
class Host {
  readonly showContent = signal(false);
  readonly label = signal('Вкладки');
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
});
