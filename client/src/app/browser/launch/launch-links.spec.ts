import { TestBed } from '@angular/core/testing';
import { AppOpenEvent, PageViews } from '../page-views/page-views';
import { LaunchLinks } from './launch-links';

/** Події з Rust без Rust: `emit` — як повторний запуск браузера. */
class FakePageViews {
  readonly available = true;
  private handler: ((event: AppOpenEvent) => void) | null = null;

  on(_event: string, handler: (event: AppOpenEvent) => void): Promise<() => void> {
    this.handler = handler;
    return Promise.resolve(() => undefined);
  }

  emit(event: AppOpenEvent): void {
    this.handler?.(event);
  }
}

describe('LaunchLinks', () => {
  const setup = () => {
    TestBed.configureTestingModule({ providers: [{ provide: PageViews, useClass: FakePageViews }] });
    const links = TestBed.inject(LaunchLinks);
    const pages = TestBed.inject(PageViews) as unknown as FakePageViews;
    return { links, pages };
  };

  it('should keep links that came before the browser was shown and drop bare restarts', () => {
    const { links, pages } = setup();
    pages.emit({ urls: ['https://t.me/astra'] });
    pages.emit({ urls: [] });

    const opened: AppOpenEvent[] = [];
    links.attach((event) => opened.push(event));
    expect(opened).toEqual([{ urls: ['https://t.me/astra'] }]);

    pages.emit({ urls: [] });
    expect(opened).toEqual([{ urls: ['https://t.me/astra'] }, { urls: [] }]);
  });

  it('should wait again once the browser is gone', () => {
    const { links, pages } = setup();
    const opened: AppOpenEvent[] = [];
    const detach = links.attach((event) => opened.push(event));
    detach();

    pages.emit({ urls: ['https://mail.example/'] });
    expect(opened).toEqual([]);
    links.attach((event) => opened.push(event));
    expect(opened).toEqual([{ urls: ['https://mail.example/'] }]);
  });
});
