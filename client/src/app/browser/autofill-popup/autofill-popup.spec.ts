import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  Address,
  AddressCommand,
  AddressCommandArgs,
  AddressCommandResult,
  AddressesStore,
  EMPTY_ADDRESS,
} from '../data/addresses';
import { CardCommand, CardCommandArgs, CardCommandResult, CardInfo, CardsStore } from '../data/cards';
import { AutofillPopup } from './autofill-popup';

const ADDRESSES: Address[] = [
  {
    id: 'home',
    fields: { ...EMPTY_ADDRESS, given: 'Іван', family: 'Петренко', line1: 'вул. Хрещатик, 1', city: 'Київ' },
    created: 1,
    updated: 1,
    used: null,
  },
  {
    id: 'work',
    fields: { ...EMPTY_ADDRESS, organization: 'ТОВ «Астра»', city: 'Львів', phone: '0321234567' },
    created: 1,
    updated: 1,
    used: null,
  },
];

/** Адреси без Rust: стан — дві адреси, команди записуються. */
class FakeAddresses extends AddressesStore {
  readonly calls: [AddressCommand, readonly unknown[]][] = [];

  protected override call<K extends AddressCommand>(command: K, ...args: AddressCommandArgs<K>): AddressCommandResult<K> {
    this.calls.push([command, args]);
    const state = { entries: ADDRESSES, settings: { offer: true, autofill: true } };
    return Promise.resolve(command === 'addressesState' ? state : undefined) as AddressCommandResult<K>;
  }
}

const CARDS: CardInfo[] = [
  {
    id: 'visa',
    brand: 'visa',
    last4: '4242',
    holder: 'IVAN PETRENKO',
    month: 7,
    year: 2099,
    nickname: '',
    created: 1,
    updated: 1,
    used: null,
  },
  {
    id: 'old',
    brand: 'mastercard',
    last4: '4444',
    holder: '',
    month: 1,
    year: 2020,
    nickname: 'Стара',
    created: 1,
    updated: 1,
    used: null,
  },
];

/** Картки без Rust: дві картки, заповнення записується. */
class FakeCards extends CardsStore {
  readonly calls: [CardCommand, readonly unknown[]][] = [];

  protected override call<K extends CardCommand>(command: K, ...args: CardCommandArgs<K>): CardCommandResult<K> {
    this.calls.push([command, args]);
    const state = { entries: CARDS, settings: { offer: true, autofill: true, verify: true }, hello: true };
    return Promise.resolve(command === 'cardsState' ? state : true) as CardCommandResult<K>;
  }
}

describe('AutofillPopup', () => {
  const page = { x: 0, y: 100, width: 800, height: 500 };
  const field = { x: 40, y: 60, width: 300, height: 32 };

  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [AutofillPopup],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AddressesStore, useClass: FakeAddresses },
        { provide: CardsStore, useClass: FakeCards },
      ],
    }).compileComponents();
    const store = TestBed.inject(AddressesStore) as FakeAddresses;
    await store.refresh();
    const cards = TestBed.inject(CardsStore) as FakeCards;
    await cards.refresh();
    const fixture = TestBed.createComponent(AutofillPopup);
    await fixture.whenStable();
    const popup = fixture.componentInstance;
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    const fills = () => store.calls.filter(([command]) => command === 'addressAutofill').map(([, args]) => args);
    const panel = () => element.querySelector<HTMLElement>('.autofill');
    return { fixture, popup, element, stable, text, fills, panel, cards };
  };

  it('should show what each address puts into the field, under the field', async () => {
    const { popup, stable, text, panel } = await setup();
    popup.show('page-1', 'address', 'city', ['work', 'home'], field, page);
    await stable();

    expect(text('.autofill__value')).toEqual(['Львів', 'Київ']);
    expect(text('.autofill__detail')).toEqual(['ТОВ «Астра»', 'Іван Петренко']);
    expect(text('.autofill__manage')).toEqual(['Керувати адресами…']);
    // Під полем: 100 (сайт) + 60 + 32 (поле) + 4.
    expect(panel()?.style.top).toBe('196px');
    expect(panel()?.style.left).toBe('40px');
    // Регіон інтерфейсу не лягає на поле над списком.
    expect(JSON.parse(panel()?.dataset['layerMargins'] ?? 'null')).toEqual([4, 24, 32, 24]);
  });

  it('should pick an address with the keys from the page and fill the form with it', async () => {
    const { popup, stable, element, fills } = await setup();
    popup.show('page-1', 'address', 'name', ['home'], field, page);
    await stable();

    popup.key('page-1', 'ArrowDown');
    await stable();
    expect(element.querySelector('.autofill__item--selected .autofill__value')?.textContent?.trim()).toBe('Іван Петренко');
    // Клавіші іншого сайту не рахуються.
    popup.key('page-2', 'ArrowDown');
    popup.key('page-1', 'Enter');
    await stable();

    expect(fills()).toEqual([['page-1', 'home']]);
    expect(element.querySelector('.autofill__item--selected')).toBeNull();
  });

  it('should open the addresses page from the last item', async () => {
    const { fixture, popup, stable, fills } = await setup();
    const manage = vi.fn();
    fixture.componentInstance.manage.subscribe(manage);
    popup.show('page-1', 'address', 'city', ['home', 'work'], field, page);
    await stable();

    popup.key('page-1', 'ArrowUp');
    popup.key('page-1', 'Enter');
    expect(manage).toHaveBeenCalledTimes(1);
    expect(fills()).toEqual([]);
  });

  it('should fill on a click and hide on a click elsewhere in the interface', async () => {
    const { popup, stable, element, fills } = await setup();
    popup.show('page-1', 'address', 'city', ['home', 'work'], field, page);
    await stable();

    element.querySelectorAll<HTMLButtonElement>('.autofill__item')[1].click();
    expect(fills()).toEqual([['page-1', 'work']]);

    const hide = vi.spyOn(popup, 'hide');
    popup.show('page-1', 'address', 'city', ['home'], field, page);
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(hide).toHaveBeenCalled();
  });

  it('should hide when the window loses focus but not when the focus comes to the list', async () => {
    const { popup } = await setup();
    vi.useFakeTimers();
    try {
      const hide = vi.spyOn(popup, 'hide');
      const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
      popup.show('page-1', 'address', 'city', ['home'], field, page);

      popup.blur('page-1');
      vi.advanceTimersByTime(200);
      expect(hide).not.toHaveBeenCalled();

      focused.mockReturnValue(false);
      popup.blur('page-1');
      vi.advanceTimersByTime(200);
      expect(hide).toHaveBeenCalled();
      focused.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('should hide when the field leaves the visible part of the site', async () => {
    const { popup } = await setup();
    popup.show('page-1', 'address', 'city', ['home'], field, page);
    const hide = vi.spyOn(popup, 'hide');

    popup.move('page-1', { ...field, y: -200 }, page);
    expect(hide).toHaveBeenCalled();
  });
  it('should show cards without their numbers and fill the form with the picked one', async () => {
    const { fixture, popup, stable, text, element, fills, cards } = await setup();
    const manage = vi.fn();
    fixture.componentInstance.manage.subscribe(manage);
    popup.show('page-1', 'card', 'cc-number', ['visa', 'old'], field, page);
    await stable();

    expect(text('.autofill__value')).toEqual(['Visa •••• 4242', 'Стара']);
    expect(text('.autofill__detail')).toEqual(['IVAN PETRENKO · до 07/99', 'Mastercard •••• 4444 · Термін дії минув']);
    expect(text('.autofill__manage')).toEqual(['Керувати картками…']);
    expect(element.querySelector('.autofill')?.getAttribute('aria-label')).toBe('Збережені картки');

    element.querySelectorAll<HTMLButtonElement>('.autofill__item')[0].click();
    expect(cards.calls.filter(([command]) => command === 'cardAutofill').map(([, args]) => args)).toEqual([['page-1', 'visa']]);
    expect(fills()).toEqual([]);

    popup.show('page-1', 'card', 'cc-name', ['visa'], field, page);
    await stable();
    expect(text('.autofill__value')).toEqual(['IVAN PETRENKO']);
    popup.key('page-1', 'ArrowUp');
    popup.key('page-1', 'Enter');
    expect(manage).toHaveBeenCalledWith('card');
  });
});
