import { TestBed } from '@angular/core/testing';
import { SHORTCUTS } from '../internal-pages';
import { HelpPage } from './help-page';

describe('HelpPage', () => {
  it('should list the working shortcuts and the versions known outside Tauri', async () => {
    await TestBed.configureTestingModule({ imports: [HelpPage] }).compileComponents();
    const fixture = TestBed.createComponent(HelpPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;

    const rows = [...element.querySelectorAll('.help-table__row')];
    expect(rows.length).toBe(SHORTCUTS.length);
    expect(rows[0].querySelector('th')?.textContent?.trim()).toBe('Нова вкладка');
    expect([...rows[0].querySelectorAll('kbd')].map((key) => key.textContent)).toEqual(['Ctrl', 'T']);

    const about = [...element.querySelectorAll('.help-about dd')].map((value) => value.textContent?.trim());
    expect(about[0]).toBe('Версія розробки');
    expect(about[1]).toBe('—');
  });
});
