import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Titlebar } from '../shared/titlebar/titlebar';
import { Browser } from './browser';

// Вкладки браузера рендеряться в спільному заголовку вікна, тож тестуємо їх разом, як в App.
@Component({
  imports: [Browser, Titlebar],
  template: '<app-titlebar /><app-browser />',
})
class Host {}

describe('Browser', () => {
  let fixture: ComponentFixture<Host>;
  let element: HTMLElement;

  const tabTitles = () => [...element.querySelectorAll('.tab__title')].map((title) => title.textContent?.trim());
  const activeTitle = () => element.querySelector('.tab--active .tab__title')?.textContent?.trim();
  const closeButton = (index: number) => element.querySelectorAll<HTMLButtonElement>('.tab__close')[index];

  const click = async (button: HTMLElement | undefined) => {
    button?.click();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    fixture = TestBed.createComponent(Host);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  it('should start on the new tab page', () => {
    expect(activeTitle()).toBe('Нова вкладка');
    expect(element.querySelector('app-new-tab')).toBeTruthy();
    expect(element.querySelectorAll('.bookmark').length).toBe(6);
  });

  it('should open a new tab and make it active', async () => {
    await click(element.querySelector<HTMLButtonElement>('.new-tab-button') ?? undefined);

    expect(tabTitles().length).toBe(5);
    expect(element.querySelectorAll('.tab')[4].classList).toContain('tab--active');
  });

  it('should activate the tab to the right when the active tab is closed', async () => {
    await click(closeButton(0));

    expect(tabTitles()).toEqual(['Product Ideas', 'Design Research', 'Travel Plans']);
    expect(activeTitle()).toBe('Product Ideas');
    expect(element.querySelector('app-new-tab')).toBeNull();
  });

  it('should keep the active tab when another tab is closed', async () => {
    await click(closeButton(2));

    expect(tabTitles()).toEqual(['Нова вкладка', 'Product Ideas', 'Travel Plans']);
    expect(activeTitle()).toBe('Нова вкладка');
  });

  it('should replace the last closed tab with a new one', async () => {
    for (let i = 0; i < 4; i++) {
      await click(closeButton(0));
    }

    expect(tabTitles()).toEqual(['Нова вкладка']);
    expect(activeTitle()).toBe('Нова вкладка');
  });
});
