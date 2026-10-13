import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ProfileStore } from '../data/profile';
import { InternalPage } from '../pages/internal-pages';
import { ProfileMenu } from './profile-menu';

describe('ProfileMenu', () => {
  const setup = async (guest = false) => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ProfileMenu],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProfileMenu);
    fixture.componentRef.setInput('guest', guest);
    const events: (InternalPage | 'guest' | 'close-guest')[] = [];
    fixture.componentInstance.openPage.subscribe((page) => events.push(page));
    fixture.componentInstance.openGuest.subscribe(() => events.push('guest'));
    fixture.componentInstance.closeGuest.subscribe(() => events.push('close-guest'));
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const item = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes(label));
    return { fixture, element, events, item };
  };

  it('should show the profile and open its pages and the guest mode', async () => {
    const { fixture, element, events, item } = await setup();
    expect(element.querySelector('.profile-menu__name')?.textContent?.trim()).toBe('Користувач');

    TestBed.inject(ProfileStore).name.set('Роман');
    await fixture.whenStable();
    expect(element.querySelector('.profile-menu__name')?.textContent?.trim()).toBe('Роман');
    expect(element.querySelector('.profile-menu__avatar .avatar__initials')?.textContent).toBe('Р');

    for (const label of ['Керування профілем', 'Паролі', 'Адреси', 'Персоналізація', 'Гостьовий режим']) {
      item(label)?.click();
    }
    expect(events).toEqual(['profile', 'passwords', 'addresses', 'personalization', 'guest']);
  });

  it('should only offer to leave the guest mode in a guest window', async () => {
    const { element, events, item } = await setup(true);

    expect(element.querySelector('.profile-menu__name')?.textContent?.trim()).toBe('Гість');
    expect(element.querySelector('.profile-menu__list')).toBeNull();
    expect(element.querySelector('.avatar--guest')).toBeTruthy();
    item('Вийти з гостьового режиму')?.click();
    expect(events).toEqual(['close-guest']);
  });
});
