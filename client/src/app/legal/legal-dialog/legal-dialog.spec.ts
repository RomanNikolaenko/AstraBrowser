import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { I18n } from '../../shared/i18n/i18n';
import { LEGAL_CONTACT } from '../contact';
import { LegalKind, legalDocument } from '../legal-document';
import { LegalDialog } from './legal-dialog';

describe('LegalDialog', () => {
  let fixture: ComponentFixture<LegalDialog>;
  let element: HTMLElement;

  const title = () => element.querySelector('.legal-dialog__title')?.textContent?.trim();
  const text = () => element.querySelector('.legal-dialog__body')?.textContent ?? '';

  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [LegalDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(LegalDialog);
    element = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach(() => localStorage.clear());

  it('should show the chosen document in the interface language', async () => {
    fixture.componentInstance.show('privacy');
    await fixture.whenStable();
    expect(title()).toBe('Політика конфіденційності');
    expect(text()).toContain(LEGAL_CONTACT);
    expect(element.querySelector('dialog')?.getAttribute('lang')).toBe('uk');

    TestBed.inject(I18n).preference.set('en');
    await fixture.whenStable();
    expect(title()).toBe('Privacy Policy');
    expect(element.querySelector('dialog')?.getAttribute('lang')).toBe('en');

    fixture.componentInstance.show('terms');
    await fixture.whenStable();
    expect(title()).toBe('Terms of Use');
    expect(text()).toContain('Governing law');
  });

  it('should have the same sections in both languages', () => {
    for (const kind of ['terms', 'privacy'] as LegalKind[]) {
      const uk = legalDocument(kind, 'uk');
      const en = legalDocument(kind, 'en');
      const shape = (document: typeof uk) =>
        [document.intro, ...document.sections.map((section) => section.blocks)].map((blocks) =>
          blocks.map((block) => (Array.isArray(block) ? block.length : 'p'))
        );
      expect(shape(en), kind).toEqual(shape(uk));
      expect(
        en.sections.map((section) => section.heading.split('.')[0]),
        kind
      ).toEqual(uk.sections.map((section) => section.heading.split('.')[0]));
    }
  });
});
