import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { BookmarksStore } from '../../data/bookmarks';
import { ProfileStore, initialsOf } from '../../data/profile';
import { PageViews } from '../../page-views/page-views';
import { ProfilePage } from './profile-page';

describe('ProfilePage', () => {
  const setup = async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ProfilePage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProfilePage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim().startsWith(label));
    return { fixture, element, stable, button, profile: TestBed.inject(ProfileStore) };
  };

  it('should name the profile and color its avatar', async () => {
    const { element, stable, profile } = await setup();
    expect(element.querySelector('.avatar__initials')).toBeNull();

    const name = element.querySelector<HTMLInputElement>('#profile-name');
    if (name) {
      name.value = 'Роман Ніколаєнко';
      name.dispatchEvent(new Event('input'));
    }
    await stable();
    expect(profile.displayName()).toBe('Роман Ніколаєнко');
    expect(element.querySelector('.avatar__initials')?.textContent).toBe('РН');

    element.querySelector<HTMLInputElement>('input[aria-label="Зелений"]')?.click();
    await stable();
    expect(profile.color()).toBe('green');
  });

  it('should import bookmarks from another browser and export its own', async () => {
    const { element, stable, button } = await setup();
    const save = vi.spyOn(TestBed.inject(PageViews), 'saveFile').mockResolvedValue('C:\\Users\\me\\Documents\\Закладки.html');
    expect(button('Експортувати')?.disabled).toBe(true);

    const input = element.querySelector<HTMLInputElement>('input[aria-label="Файл закладок"]') as HTMLInputElement;
    const file = new File(
      [
        '<DL><p><DT><H3>Bar</H3><DL><p><DT><A HREF="https://github.com/">GitHub</A><DT><A HREF="https://www.hltv.org/">HLTV</A></DL><p></DL>',
      ],
      'bookmarks.html',
      { type: 'text/html' }
    );
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
    await stable();
    await stable();

    expect(element.querySelector('.profile__message')?.textContent).toContain('Імпортовано закладок: 2');
    const bar = TestBed.inject(BookmarksStore).bar();
    expect(bar.map((item) => item.type)).toEqual(['folder']);
    expect(
      TestBed.inject(BookmarksStore)
        .entries()
        .map((bookmark) => bookmark.title)
    ).toEqual(['GitHub', 'HLTV']);
    expect(element.querySelector('.profile__stat-value')?.textContent).toBe('2');

    button('Експортувати')?.click();
    await stable();
    expect(save).toHaveBeenCalledTimes(1);
    const [content, name, kind] = save.mock.calls[0];
    expect(new TextDecoder().decode(content)).toContain('<DT><A HREF="https://github.com/">GitHub</A>');
    expect(name).toMatch(/^Закладки \d{4}-\d\d-\d\d\.html$/);
    expect(kind).toBe('html');
    expect(element.querySelector('.profile__message')?.textContent).toContain('Закладки збережено');
  });
});

describe('initialsOf', () => {
  it('should take the first letters of the first two words', () => {
    expect(initialsOf('роман ніколаєнко молодший')).toBe('РН');
    expect(initialsOf('  Ann ')).toBe('A');
    expect(initialsOf('')).toBe('');
  });
});
