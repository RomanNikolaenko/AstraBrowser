import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { isTranslated, originalUrl, translatePageUrl, translateTextUrl } from './translate-urls';
import { Translator } from './translator';

describe('translate urls', () => {
  it('should send a page through Google Translate and find its original again', () => {
    expect(translatePageUrl('https://www.example-site.com/news?id=7', 'uk')).toBe(
      'https://translate.google.com/translate?sl=auto&tl=uk&hl=uk&u=https%3A%2F%2Fwww.example-site.com%2Fnews%3Fid%3D7'
    );

    const translated = 'https://www-example--site-com.translate.goog/news?id=7&_x_tr_sl=auto&_x_tr_tl=uk&_x_tr_hl=uk#top';
    expect(isTranslated(translated)).toBe(true);
    expect(isTranslated('https://www.example-site.com/news')).toBe(false);
    expect(originalUrl(translated)).toBe('https://www.example-site.com/news?id=7#top');
    expect(originalUrl('http://plain-com.translate.goog/?_x_tr_sch=http&_x_tr_tl=en')).toBe('http://plain.com/');
    expect(originalUrl('https://example.com/')).toBeNull();

    // Уже перекладену сторінку — знову з оригіналу, іншою мовою.
    expect(translatePageUrl(translated, 'en')).toContain('tl=en&hl=uk&u=https%3A%2F%2Fwww.example-site.com%2Fnews');
    expect(translateTextUrl('Добрий день!', 'en')).toBe(
      'https://translate.google.com/?sl=auto&tl=en&text=%D0%94%D0%BE%D0%B1%D1%80%D0%B8%D0%B9%20%D0%B4%D0%B5%D0%BD%D1%8C!&op=translate'
    );
  });
});

describe('Translator', () => {
  const setup = async (pageUrl: string) => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [Translator],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const fixture = TestBed.createComponent(Translator);
    fixture.componentRef.setInput('pageUrl', pageUrl);
    const navigated: string[] = [];
    const opened: string[] = [];
    fixture.componentInstance.navigate.subscribe((url) => navigated.push(url));
    fixture.componentInstance.openInNewTab.subscribe((url) => opened.push(url));
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim().includes(label));
    const note = () => element.querySelector('.translator__note')?.textContent?.trim();
    return { fixture, element, navigated, opened, button, note };
  };

  it('should translate the page in its tab and translate typed text in a new one', async () => {
    const { fixture, element, navigated, opened, button, note } = await setup('https://www.hltv.org/news/1');
    expect(note()).toBe('hltv.org');

    button('Перекласти сторінку')?.click();
    expect(navigated).toEqual([translatePageUrl('https://www.hltv.org/news/1', 'uk')]);

    const text = element.querySelector<HTMLTextAreaElement>('#translator-text-input');
    expect(button('Перекласти текст')?.disabled).toBe(true);
    if (text) {
      text.value = 'Good game';
      text.dispatchEvent(new Event('input'));
    }
    await fixture.whenStable();
    button('Перекласти текст')?.click();
    expect(opened).toEqual([translateTextUrl('Good game', 'uk')]);
  });

  it('should offer the original of a translated page and nothing to translate without a site', async () => {
    const translated = await setup('https://www-hltv-org.translate.goog/news/1?_x_tr_sl=auto&_x_tr_tl=uk');
    expect(translated.note()).toContain('hltv.org');
    translated.button('Показати оригінал')?.click();
    expect(translated.navigated).toEqual(['https://www.hltv.org/news/1']);

    TestBed.resetTestingModule();
    const empty = await setup('');
    expect(empty.note()).toBe('Відкрийте сайт у вкладці, щоб перекласти його сторінку.');
    expect(empty.button('Перекласти сторінку')).toBeUndefined();
  });
});
