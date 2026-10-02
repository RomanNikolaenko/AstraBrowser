import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { IconRegistry } from './icon-registry';

describe('IconRegistry', () => {
  let registry: IconRegistry;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    registry = TestBed.inject(IconRegistry);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('should request each icon once and share the markup', () => {
    const received: string[] = [];
    registry.get('close').subscribe((svg) => received.push(svg));
    registry.get('close').subscribe((svg) => received.push(svg));

    http.expectOne('assets/icons/close.svg').flush('<svg></svg>');
    registry.get('close').subscribe((svg) => received.push(svg));

    expect(received).toEqual(['<svg></svg>', '<svg></svg>', '<svg></svg>']);
  });

  it('should retry an icon that failed to load', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    registry.get('missing').subscribe();
    http.expectOne('assets/icons/missing.svg').flush('', { status: 404, statusText: 'Not Found' });

    registry.get('missing').subscribe();
    http.expectOne('assets/icons/missing.svg').flush('<svg></svg>');
  });
});
