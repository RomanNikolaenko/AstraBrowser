import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UiSelect, UiSelectOption } from './ui-select';

type Fruit = 'apple' | 'pear' | 'plum';

@Component({
  imports: [UiSelect],
  template: `
    <form>
      <label for="fruit">Фрукт</label>
      <app-select selectId="fruit" selectName="fruit" [options]="options" [(value)]="value" [disabled]="disabled()" />
    </form>
  `,
})
class Host {
  readonly options: readonly UiSelectOption<Fruit>[] = [
    { value: 'apple', label: 'Яблуко' },
    { value: 'pear', label: 'Груша' },
    { value: 'plum', label: 'Слива' },
  ];
  readonly value = signal<Fruit | undefined>('pear');
  readonly disabled = signal(false);
}

describe('UiSelect', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    })
      .compileComponents();

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const trigger = element.querySelector('[role="combobox"]') as HTMLButtonElement;
    const list = element.querySelector('[role="listbox"]') as HTMLElement;
    const options = () => [...element.querySelectorAll<HTMLElement>('[role="option"]')];
    const key = async (name: string) => {
      const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
      trigger.dispatchEvent(event);
      await fixture.whenStable();
      return event;
    };
    // jsdom не має Popover API: відкриття кліком — це подія toggle, як її шле браузер.
    const openByClick = async () => {
      list.dispatchEvent(Object.assign(new Event('toggle'), { newState: 'open' }));
      await fixture.whenStable();
    };
    return { fixture, element, trigger, list, options, key, openByClick };
  };

  it('should render a labelled combobox showing the current option', async () => {
    const { trigger, list, element } = await setup();

    expect(trigger.id).toBe('fruit');
    expect(trigger.labels?.[0]?.textContent).toBe('Фрукт');
    expect(trigger.getAttribute('aria-controls')).toBe(list.id);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('popovertarget')).toBe(list.id);
    expect(trigger.textContent?.trim()).toBe('Груша');
    expect(element.querySelector<HTMLInputElement>('input[type="hidden"]')?.value).toBe('pear');
  });

  it('should pick an option with the mouse', async () => {
    const { fixture, trigger, options, openByClick } = await setup();
    await openByClick();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(options().map((option) => [option.textContent?.trim(), option.getAttribute('aria-selected')])).toEqual([['Яблуко', 'false'], ['Груша', 'true'], ['Слива', 'false']]);
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[1].id);

    options()[2].click();
    await fixture.whenStable();

    expect(fixture.componentInstance.value()).toBe('plum');
    expect(trigger.textContent?.trim()).toBe('Слива');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('should be fully usable from the keyboard', async () => {
    const { fixture, trigger, options, key } = await setup();

    await key('ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[1].id);

    await key('ArrowDown');
    await key('ArrowDown');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[2].id);
    await key('Home');
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options()[0].id);

    const enter = await key('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.value()).toBe('apple');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    // У закритому списку літера одразу вибирає пункт, як у звичайному select.
    await key('с');
    expect(fixture.componentInstance.value()).toBe('plum');
  });

  it('should close on Escape without letting it reach the surrounding panel', async () => {
    const { fixture, trigger, key } = await setup();
    await key('ArrowDown');

    const escape = await key('Escape');

    expect(escape.defaultPrevented).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.componentInstance.value()).toBe('pear');
  });

  it('should follow the value set from outside and be disabled on demand', async () => {
    const { fixture, trigger } = await setup();

    fixture.componentInstance.value.set('apple');
    fixture.componentInstance.disabled.set(true);
    await fixture.whenStable();

    expect(trigger.textContent?.trim()).toBe('Яблуко');
    expect(trigger.disabled).toBe(true);
  });
});
