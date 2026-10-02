import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FindBar, findMatches } from './find-bar';

describe('findMatches', () => {
  const page = (html: string) => {
    const root = document.createElement('div');
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  afterEach(() => document.body.replaceChildren());

  it('should find every case-insensitive occurrence across text nodes', () => {
    const root = page('<h1>Нова вкладка</h1><p>Відкрийте <b>нову</b> вкладку чи НОВЕ вікно</p>');

    const matches = findMatches(root, 'нов');

    expect(matches.map((range) => range.toString())).toEqual(['Нов', 'нов', 'НОВ']);
  });

  it('should ignore form fields and an empty query', () => {
    const root = page('<p>пошук</p><input value="пошук" /><textarea>пошук</textarea>');

    expect(findMatches(root, 'пошук').length).toBe(1);
    expect(findMatches(root, '   ')).toEqual([]);
  });
});

@Component({
  imports: [FindBar],
  template: `
    <div #page><p>alpha beta alpha</p><p>Alpha</p></div>
    <app-find-bar [root]="page" (closed)="closed = closed + 1" />
  `,
})
class Host {
  closed = 0;
}

describe('FindBar', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('#find-on-page') as HTMLInputElement;
    const status = () => element.querySelector('.find-bar__status')?.textContent?.trim();
    const type = async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await fixture.whenStable();
    };
    const key = async (init: KeyboardEventInit) => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
      await fixture.whenStable();
    };
    return { fixture, element, input, status, type, key };
  };

  it('should focus the field when opened', async () => {
    const { input } = await setup();

    expect(document.activeElement).toBe(input);
  });

  it('should count matches and move between them with Enter and Shift+Enter', async () => {
    const { status, type, key } = await setup();

    await type('alpha');
    expect(status()).toBe('1 / 3');

    await key({ key: 'Enter' });
    await key({ key: 'Enter' });
    expect(status()).toBe('3 / 3');

    await key({ key: 'Enter' });
    expect(status()).toBe('1 / 3');

    await key({ key: 'Enter', shiftKey: true });
    expect(status()).toBe('3 / 3');
  });

  it('should report when nothing matches', async () => {
    const { element, status, type } = await setup();

    await type('gamma');

    expect(status()).toBe('Немає збігів');
    expect(element.querySelector<HTMLButtonElement>('[aria-label="Наступний збіг"]')?.disabled).toBe(true);
  });

  it('should close on Escape', async () => {
    const { fixture, key } = await setup();

    await key({ key: 'Escape' });

    expect(fixture.componentInstance.closed).toBe(1);
  });
});
