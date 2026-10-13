import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CardCommand, CardCommandArgs, CardCommandResult, CardInfo, CardInput, CardSettings, CardsStore } from '../../data/cards';
import { CardsPage } from './cards-page';

/** Картки без Rust: команди виконуються над сховищем у пам'яті (номери — лише тут) і записуються. */
class FakeCards extends CardsStore {
  readonly calls: [CardCommand, readonly unknown[]][] = [];
  private saved: CardInfo[] = [];
  private settingsValue: CardSettings = { offer: true, autofill: true, verify: true };
  helloValue = true;
  private nextId = 1;

  seed(cards: readonly Partial<CardInfo>[]): Promise<void> {
    for (const card of cards) {
      this.saved.push({
        id: String(this.nextId++),
        brand: 'visa',
        last4: '4242',
        holder: '',
        month: 7,
        year: 2099,
        nickname: '',
        created: 1,
        updated: 1,
        used: null,
        ...card,
      });
    }
    return this.refresh();
  }

  protected override call<K extends CardCommand>(command: K, ...args: CardCommandArgs<K>): CardCommandResult<K> {
    this.calls.push([command, args]);
    const done = (value?: unknown) => Promise.resolve(value) as CardCommandResult<K>;
    switch (command) {
      case 'cardsState':
        return done({ entries: [...this.saved], settings: this.settingsValue, hello: this.helloValue });
      case 'cardSave': {
        const [id, card] = args as [string | null, CardInput];
        const digits = card.number.replace(/\D/g, '');
        if (!id && digits.length < 12) {
          return Promise.reject('Некоректний номер картки') as CardCommandResult<K>;
        }
        const fields = { holder: card.holder, month: card.month, year: card.year, nickname: card.nickname };
        if (id) {
          this.saved = this.saved.map((entry) =>
            entry.id === id ? { ...entry, ...fields, ...(digits ? { last4: digits.slice(-4) } : {}) } : entry
          );
        } else {
          this.saved.push({
            id: String(this.nextId++),
            brand: 'mastercard',
            last4: digits.slice(-4),
            created: 1,
            updated: 1,
            used: null,
            ...fields,
          });
        }
        return done();
      }
      case 'cardRemove':
        this.saved = this.saved.filter((entry) => entry.id !== args[0]);
        return done();
      case 'cardsSetSettings':
        this.settingsValue = { offer: Boolean(args[0]), autofill: Boolean(args[1]), verify: Boolean(args[2]) };
        return done();
      default:
        return done();
    }
  }
}

describe('CardsPage', () => {
  const setup = async (cards: readonly Partial<CardInfo>[] = [], hello = true) => {
    await TestBed.configureTestingModule({
      imports: [CardsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CardsStore, useClass: FakeCards }],
    }).compileComponents();
    const store = TestBed.inject(CardsStore) as FakeCards;
    store.helloValue = hello;
    await store.seed(cards);

    const fixture = TestBed.createComponent(CardsPage);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
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
    const choose = async (id: string, label: string) => {
      await click(element.querySelector(`#${id}`));
      await click([...element.querySelectorAll('[role="option"]')].find((option) => option.textContent?.trim() === label));
    };
    return { element, store, text, click, labelled, type, choose };
  };

  it('should show the empty state and the settings, Windows Hello only where it is set up', async () => {
    const { element, store, text, click } = await setup([], false);

    expect(text('.page__empty-title')).toEqual(['Карток ще немає']);
    const verify = element.querySelector<HTMLInputElement>('#cards-verify');
    expect(verify?.disabled).toBe(true);
    expect(verify?.checked).toBe(false);
    expect(text('#cards-verify-hint')[0]).toContain('не налаштовано');

    await click(element.querySelector('#cards-autofill'));
    expect(store.calls.find(([command]) => command === 'cardsSetSettings')?.[1]).toEqual([true, false, true]);
  });

  it('should list cards without their numbers and remove one', async () => {
    const { element, store, text, click, labelled } = await setup([
      { holder: 'IVAN PETRENKO', month: 7, year: 2099 },
      { brand: 'mastercard', last4: '4444', nickname: 'Зарплатна', month: 1, year: 2020 },
    ]);

    expect(text('.page__group')).toEqual(['Збережені картки · 2']);
    expect(text('.page__row .page__name')).toEqual(['Visa •••• 4242', 'Зарплатна']);
    expect(text('.page__row .page__meta')).toEqual(['IVAN PETRENKO · до 07/99', 'Mastercard •••• 4444 · Термін дії минув']);
    expect(element.querySelectorAll('.cards__row--expired')).toHaveLength(1);

    await click(labelled('Видалити картку Visa •••• 4242'));
    expect(text('.confirm-dialog__message')[0]).toBe('Картку «Visa •••• 4242» буде видалено з браузера. Скасувати це не вийде.');
    await click(
      [...element.querySelectorAll('.confirm-dialog__button')].find((button) => button.textContent?.includes('Видалити'))
    );
    expect(store.calls.some(([command, args]) => command === 'cardRemove' && args[0] === '1')).toBe(true);
    expect(text('.page__row .page__name')).toEqual(['Зарплатна']);
  });

  it('should add a card with its number and expiry date', async () => {
    const { element, store, text, click, type, choose } = await setup();
    const save = () => element.querySelector('.address-editor__button--primary');

    await click([...element.querySelectorAll('.page__button')].find((button) => button.textContent?.includes('Додати')));
    expect(text('.address-editor__title')).toEqual(['Додати картку']);
    await click(save());
    expect(text('.address-editor__error')).toEqual(['Введіть номер картки']);

    await type('card-editor-number', '5555 5555 5555 4444');
    await click(save());
    expect(text('.address-editor__error')).toEqual(['Вкажіть термін дії картки']);

    await type('card-editor-holder', 'OLENA KOVAL');
    await choose('card-editor-month', '09');
    await choose('card-editor-year', String(new Date().getFullYear() + 2));
    await click(save());

    expect(store.calls.find(([command]) => command === 'cardSave')?.[1]).toEqual([
      null,
      { number: '5555 5555 5555 4444', holder: 'OLENA KOVAL', month: 9, year: new Date().getFullYear() + 2, nickname: '' },
    ]);
    expect(text('.page__row .page__name')).toEqual(['Mastercard •••• 4444']);
  });

  it('should edit a card without showing or changing its number', async () => {
    const { element, store, text, click, labelled, type } = await setup([{ holder: 'IVAN', month: 7, year: 2099 }]);

    await click(labelled('Змінити картку Visa •••• 4242'));
    expect(text('.address-editor__title')).toEqual(['Змінити картку']);
    const number = element.querySelector<HTMLInputElement>('#card-editor-number');
    expect(number?.value).toBe('');
    expect(number?.placeholder).toBe('•••• 4242 — лишіть порожнім, щоб не змінювати');
    await type('card-editor-nickname', 'Для покупок');
    await click(element.querySelector('.address-editor__button--primary'));

    expect(store.calls.find(([command]) => command === 'cardSave')?.[1]).toEqual([
      '1',
      { number: '', holder: 'IVAN', month: 7, year: 2099, nickname: 'Для покупок' },
    ]);
    expect(text('.page__row .page__name')).toEqual(['Для покупок']);
  });
});
