import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { AuthStore, AuthUser } from '../../../shared/auth/auth';
import { BookmarksStore } from '../../data/bookmarks';
import { HistoryStore } from '../../data/history';
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

describe('ProfilePage account', () => {
  const USER: AuthUser = { id: '1f0c2a7e-55b1-4c3e-9d1a-7d1f1f2b3c4d', email: 'old@example.com', name: 'Роман' };

  const setup = async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [ProfilePage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const auth = TestBed.inject(AuthStore);
    auth.user.set(USER);
    const fixture = TestBed.createComponent(ProfilePage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim().startsWith(label));
    const click = async (label: string) => {
      button(label)?.click();
      await stable();
    };
    const type = (selector: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    const text = (selector: string) => element.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
    return { auth, element, button, click, type, text };
  };

  afterEach(() => clearMocks());

  it('should change the email with the codes from both letters', async () => {
    const { auth, element, button, click, type, text } = await setup();
    const change = vi.spyOn(auth, 'changeEmail').mockResolvedValue();
    const confirm = vi
      .spyOn(auth, 'confirmEmailChange')
      .mockResolvedValueOnce('old@example.com')
      .mockImplementationOnce(async () => {
        auth.user.set({ ...USER, email: 'new@example.com' });
        return null;
      });

    await click('Змінити пошту');
    // Та сама пошта — нічого не надсилаємо.
    type('#profile-new-email', 'Old@example.com');
    await click('Надіслати код');
    expect(change).not.toHaveBeenCalled();
    expect(text('.ui-input__message--visible')).toBe('Це вже пошта вашого облікового запису');

    type('#profile-new-email', 'new@example.com');
    await click('Надіслати код');
    expect(change).toHaveBeenCalledWith('new@example.com');
    expect(text('.profile__hint')).toContain('надіслали на new@example.com');
    expect(button('Надіслати ще раз')?.disabled).toBe(true);

    // Перший код прийнято — Supabase чекає ще код із листа на поточну пошту.
    type('#profile-email-code', '123 456');
    await click('Підтвердити');
    expect(confirm).toHaveBeenLastCalledWith('new@example.com', '123456');
    expect(text('.profile__hint')).toBe('Перший код прийнято. Тепер введіть код із листа на old@example.com.');

    type('#profile-email-code', '654321');
    await click('Підтвердити');
    expect(element.querySelector('#profile-email-code')).toBeNull();
    expect(text('.profile__message')).toBe('Пошту змінено. Тепер входьте з new@example.com.');
  });

  it('should delete the account only with the password and then clear the data of its sites', async () => {
    const { auth, element, button, click, type, text } = await setup();
    TestBed.inject(HistoryStore).record('https://github.com/RomanNikolaenko', 'GitHub');
    const cleared: unknown[] = [];
    mockIPC((command, args) => {
      if (command === 'browsing_data_clear') {
        cleared.push(args);
      }
      return null;
    });
    const remove = vi
      .spyOn(auth, 'deleteAccount')
      .mockRejectedValueOnce({ code: 'invalid_credentials', message: 'Неправильний пароль.' })
      .mockImplementationOnce((_password, clearSiteData) => clearSiteData());

    await click('Видалити…');
    expect(text('.profile__hint')).toContain('old@example.com буде видалено назавжди');
    await click('Видалити назавжди');
    expect(remove).not.toHaveBeenCalled();

    type('#profile-delete-password', 'wrong');
    await click('Видалити назавжди');
    expect(remove).toHaveBeenLastCalledWith('wrong', expect.any(Function));
    expect(text('.profile__error')).toBe('Неправильний пароль.');
    expect(cleared).toEqual([]);

    type('#profile-delete-password', 'secret');
    await click('Видалити назавжди');
    expect(remove).toHaveBeenLastCalledWith('secret', expect.any(Function));
    expect(cleared).toEqual([
      {
        kinds: { siteData: true, cache: true, history: true, autofill: true, settings: true },
        since: 0,
        origins: ['https://github.com'],
      },
    ]);
    // Далі вікно перезавантажується на сторінку входу — кнопка лишається вимкненою.
    expect(button('Видаляємо')?.disabled).toBe(true);
    expect(element.querySelector('.profile__error')).toBeNull();
  });
});

describe('initialsOf', () => {
  it('should take the first letters of the first two words', () => {
    expect(initialsOf('роман ніколаєнко молодший')).toBe('РН');
    expect(initialsOf('  Ann ')).toBe('A');
    expect(initialsOf('')).toBe('');
  });
});
