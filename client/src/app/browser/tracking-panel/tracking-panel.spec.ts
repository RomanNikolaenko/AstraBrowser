import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SettingsStore } from '../../shared/settings/settings';
import { BlockedTracker, TrackingStore } from '../data/tracking';
import { PageViews } from '../page-views/page-views';
import { TrackingPanel } from './tracking-panel';

describe('TrackingPanel', () => {
  const TRACKERS: BlockedTracker[] = [
    { category: 'tracking', host: 'www.google-analytics.com' },
    { category: 'tracking', host: 'mc.yandex.ru' },
    { category: 'social', host: 'connect.facebook.net' },
  ];

  const setup = async (url = 'https://www.twitch.tv/directory', trackers: readonly BlockedTracker[] = TRACKERS) => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [TrackingPanel],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const pageViews = TestBed.inject(PageViews);
    const reload = vi.spyOn(pageViews, 'reload').mockResolvedValue();
    const reloadWith = vi.spyOn(pageViews, 'reloadWith').mockResolvedValue();
    const fixture = TestBed.createComponent(TrackingPanel);
    fixture.componentRef.setInput('page', 'page-1');
    fixture.componentRef.setInput('pageUrl', url);
    fixture.componentRef.setInput('trackers', trackers);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = (selector: string) => element.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim().startsWith(label));
    return { fixture, element, text, button, reload, reloadWith, tracking: TestBed.inject(TrackingStore) };
  };

  it('should count what was blocked on the site and list it by category', async () => {
    const { fixture, element, text, button } = await setup();

    expect(text('.tracking-panel__host')).toBe('www.twitch.tv');
    expect(text('.tracking-panel__connection')).toBe('Захищене з’єднання');
    expect(text('.tracking-panel__title')).toBe('Astra на сторожі');
    expect(text('.tracking-panel__count')).toBe('3 елементи стеження заблоковано на цьому сайті');
    expect(element.querySelector('.tracking-panel__groups')).toBeNull();

    button('Показати все')?.click();
    await fixture.whenStable();
    const groups = [...element.querySelectorAll('.tracking-panel__group')].map((group) => ({
      label: group.querySelector('.tracking-panel__group-label')?.textContent?.trim(),
      hosts: [...group.querySelectorAll('.tracking-panel__host-item')].map((host) => host.textContent?.trim()),
    }));
    expect(groups).toEqual([
      { label: 'Елементи стеження', hosts: ['www.google-analytics.com', 'mc.yandex.ru'] },
      { label: 'Елементи стеження соцмереж', hosts: ['connect.facebook.net'] },
    ]);
  });

  it('should say when nothing was found and when the connection is not secure', async () => {
    const { text, button } = await setup('http://example.com/', []);

    expect(text('.tracking-panel__connection')).toBe('Незахищене з’єднання');
    expect(text('.tracking-panel__count')).toBe('Елементів стеження на цьому сайті не знайдено');
    expect(button('Показати все')).toBeUndefined();
  });

  it('should turn the protection off for the site and reload it', async () => {
    const { fixture, element, text, reload, tracking } = await setup();

    element.querySelector<HTMLInputElement>('#tracking-panel-site')?.click();
    await fixture.whenStable();

    expect(tracking.exceptions()).toEqual(['twitch.tv']);
    expect(reload).toHaveBeenCalledWith('page-1');
    expect(text('.tracking-panel__title')).toBe('Захист вимкнено для цього сайту');
    expect(element.querySelector('.tracking-panel__count')).toBeNull();
    expect(text('.tracking-panel__row-title')).toBe('Захист від стеження вимкнено');

    element.querySelector<HTMLInputElement>('#tracking-panel-site')?.click();
    await fixture.whenStable();
    expect(tracking.exceptions()).toEqual([]);
    expect(text('.tracking-panel__title')).toBe('Astra на сторожі');
  });

  it('should hide the switch when the protection is off everywhere', async () => {
    const { fixture, element, text } = await setup();

    TestBed.inject(SettingsStore).trackingProtection.set('off');
    await fixture.whenStable();

    expect(text('.tracking-panel__title')).toBe('Захист від стеження вимкнено');
    expect(element.querySelector('#tracking-panel-site')).toBeNull();
  });

  it('should clear the cookies and data of the site only after confirmation', async () => {
    const { fixture, element, button, reloadWith } = await setup();

    button('Стерти файли cookie')?.click();
    await fixture.whenStable();
    expect(reloadWith).not.toHaveBeenCalled();

    element.querySelector<HTMLButtonElement>('.confirm-dialog__button--confirm')?.click();
    await fixture.whenStable();
    expect(reloadWith).toHaveBeenCalledWith('page-1', 'all');
  });

  it('should open the privacy settings', async () => {
    const { fixture, button } = await setup();
    const opened = vi.fn();
    fixture.componentInstance.openSettings.subscribe(opened);

    button('Налаштування приватності')?.click();

    expect(opened).toHaveBeenCalledTimes(1);
  });
});

describe('TrackingStore', () => {
  beforeEach(() => localStorage.clear());

  it('should keep exceptions per site, with their subdomains', () => {
    const tracking = TestBed.inject(TrackingStore);

    expect(tracking.protects('https://news.example.com/a')).toBe(true);
    tracking.setProtected('https://www.example.com/', false);
    expect(tracking.exceptions()).toEqual(['example.com']);
    expect(tracking.protects('https://news.example.com/a')).toBe(false);
    expect(tracking.protects('https://example.org/')).toBe(true);
    expect(tracking.protects('about:blank')).toBe(false);

    // Увімкнули на піддомені — виняток для всього домену теж прибрано.
    tracking.setProtected('https://news.example.com/a', true);
    expect(tracking.exceptions()).toEqual([]);

    tracking.setProtected('https://shop.example.net/', false);
    tracking.removeException('shop.example.net');
    expect(tracking.rules()).toEqual({ level: 'standard', gpc: true, exceptions: [] });
  });
});
