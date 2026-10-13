import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  Address,
  AddressCommand,
  AddressCommandArgs,
  AddressCommandResult,
  AddressFields,
  AddressSettings,
  AddressesStore,
  EMPTY_ADDRESS,
} from '../../data/addresses';
import { AddressesPage } from './addresses-page';

/** Адреси без Rust: команди виконуються над книгою в пам'яті й записуються. */
class FakeAddresses extends AddressesStore {
  readonly calls: [AddressCommand, readonly unknown[]][] = [];
  private saved: Address[] = [];
  private settingsValue: AddressSettings = { offer: true, autofill: true };
  private nextId = 1;

  seed(addresses: readonly Partial<AddressFields>[]): Promise<void> {
    for (const fields of addresses) {
      this.put({ ...EMPTY_ADDRESS, ...fields });
    }
    return this.refresh();
  }

  protected override call<K extends AddressCommand>(command: K, ...args: AddressCommandArgs<K>): AddressCommandResult<K> {
    this.calls.push([command, args]);
    const done = (value?: unknown) => Promise.resolve(value) as AddressCommandResult<K>;
    switch (command) {
      case 'addressesState':
        return done({ entries: [...this.saved], settings: this.settingsValue });
      case 'addressSave': {
        const [id, fields] = args as [string | null, AddressFields];
        if (id) {
          this.saved = this.saved.map((entry) => (entry.id === id ? { ...entry, fields } : entry));
        } else {
          this.put(fields);
        }
        return done();
      }
      case 'addressRemove':
        this.saved = this.saved.filter((entry) => entry.id !== args[0]);
        return done();
      case 'addressesSetSettings':
        this.settingsValue = { offer: Boolean(args[0]), autofill: Boolean(args[1]) };
        return done();
      default:
        return done();
    }
  }

  private put(fields: AddressFields): void {
    this.saved.push({ id: String(this.nextId++), fields, created: 1, updated: 1, used: null });
  }
}

describe('AddressesPage', () => {
  const setup = async (addresses: readonly Partial<AddressFields>[] = []) => {
    await TestBed.configureTestingModule({
      imports: [AddressesPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AddressesStore, useClass: FakeAddresses }],
    }).compileComponents();
    const store = TestBed.inject(AddressesStore) as FakeAddresses;
    await store.seed(addresses);

    const fixture = TestBed.createComponent(AddressesPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      // Відповіді «Rust» — проміси: даємо їм виконатися, а тоді — перемалювати сторінку.
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const click = async (node: Element | null | undefined) => {
      (node as HTMLElement | null)?.click();
      await stable();
    };
    const labelled = (label: string) => element.querySelector<HTMLElement>(`[aria-label="${label}"]`);
    const type = async (id: string, value: string) => {
      const input = element.querySelector<HTMLInputElement>(`#${id}`);
      if (input) {
        input.value = value;
        input.dispatchEvent(new Event('input'));
      }
      await stable();
    };
    return { element, store, text, click, labelled, type };
  };

  it('should show the empty state and change the settings', async () => {
    const { element, store, text, click } = await setup();

    expect(text('.page__empty-title')).toEqual(['Адрес ще немає']);
    expect(element.querySelector('#addresses-search')).toBeNull();
    expect(element.querySelector<HTMLInputElement>('#addresses-autofill')?.checked).toBe(true);

    await click(element.querySelector('#addresses-offer'));
    expect(store.calls.find(([command]) => command === 'addressesSetSettings')?.[1]).toEqual([false, true]);
    expect(element.querySelector<HTMLInputElement>('#addresses-offer')?.checked).toBe(false);
  });

  it('should list, search and remove addresses', async () => {
    const { element, store, text, click, labelled, type } = await setup([
      { given: 'Іван', family: 'Петренко', line1: 'вул. Хрещатик, 1', city: 'Київ', phone: '+380671234567' },
      { organization: 'ТОВ «Астра»', city: 'Львів' },
    ]);

    expect(text('.page__group')).toEqual(['Збережені адреси · 2']);
    expect(text('.page__row .page__name')).toEqual(['Іван Петренко', 'ТОВ «Астра»']);
    expect(text('.page__row .page__meta')).toEqual(['вул. Хрещатик, 1, Київ · +380671234567', 'Львів']);

    await type('addresses-search', 'львів');
    expect(text('.page__row .page__name')).toEqual(['ТОВ «Астра»']);
    await type('addresses-search', 'нічого');
    expect(text('.page__no-results')[0]).toContain('нічого');
    await type('addresses-search', '');

    await click(labelled('Видалити адресу Іван Петренко'));
    expect(text('.confirm-dialog__message')[0]).toBe('Адресу «Іван Петренко» буде видалено з браузера. Скасувати це не вийде.');
    await click(
      [...element.querySelectorAll('.confirm-dialog__button')].find((button) => button.textContent?.includes('Видалити'))
    );
    expect(store.calls.some(([command, args]) => command === 'addressRemove' && args[0] === '1')).toBe(true);
    expect(text('.page__row .page__name')).toEqual(['ТОВ «Астра»']);
  });

  it('should add an address by hand only with something filled in', async () => {
    const { element, store, text, click, type } = await setup();
    const save = () => element.querySelector('.address-editor__button--primary');

    await click([...element.querySelectorAll('.page__button')].find((button) => button.textContent?.includes('Додати')));
    expect(text('.address-editor__title')).toEqual(['Додати адресу']);
    await click(save());
    expect(text('.address-editor__error')).toEqual(['Заповніть хоча б одне поле']);

    await type('address-editor-given', 'Олена');
    await type('address-editor-city', 'Одеса');
    await type('address-editor-phone', '0501234567');
    await click(save());
    expect(store.calls.find(([command]) => command === 'addressSave')?.[1]).toEqual([
      null,
      { ...EMPTY_ADDRESS, given: 'Олена', city: 'Одеса', phone: '0501234567' },
    ]);
    expect(text('.page__row .page__name')).toEqual(['Олена']);
    expect(text('.page__row .page__meta')).toEqual(['Одеса · 0501234567']);
  });

  it('should edit a saved address', async () => {
    const { element, store, text, click, labelled, type } = await setup([{ given: 'Іван', city: 'Київ' }]);

    await click(labelled('Змінити адресу Іван'));
    expect(text('.address-editor__title')).toEqual(['Змінити адресу']);
    expect(element.querySelector<HTMLInputElement>('#address-editor-city')?.value).toBe('Київ');
    await type('address-editor-city', 'Вінниця');
    await click(element.querySelector('.address-editor__button--primary'));

    expect(store.calls.find(([command]) => command === 'addressSave')?.[1]).toEqual([
      '1',
      { ...EMPTY_ADDRESS, given: 'Іван', city: 'Вінниця' },
    ]);
    expect(text('.page__row .page__meta')).toEqual(['Вінниця']);
  });
});
