import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CardCommand, CardCommandArgs, CardCommandResult, CardPromptRequest, CardsStore } from '../data/cards';
import { CardPrompt } from './card-prompt';

/** Без Rust: відповіді лише записуються. */
class FakeCards extends CardsStore {
  readonly calls: [CardCommand, readonly unknown[]][] = [];

  protected override call<K extends CardCommand>(command: K, ...args: CardCommandArgs<K>): CardCommandResult<K> {
    this.calls.push([command, args]);
    return Promise.resolve(command === 'cardsState' ? null : undefined) as CardCommandResult<K>;
  }
}

describe('CardPrompt', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [CardPrompt],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: CardsStore, useClass: FakeCards }],
    }).compileComponents();
    const store = TestBed.inject(CardsStore) as FakeCards;
    const fixture = TestBed.createComponent(CardPrompt);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const ask = async (request: Partial<CardPromptRequest> = {}) => {
      store.ask({
        id: 5,
        brand: 'visa',
        last4: '4242',
        holder: 'IVAN PETRENKO',
        month: 7,
        year: 2028,
        update: false,
        ...request,
      });
      await stable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
    const answers = () => store.calls.filter(([command]) => command === 'cardPromptAnswer').map(([, args]) => args);
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    return { element, stable, ask, button, answers, text };
  };

  it('should show the card without its number and save it', async () => {
    const { element, stable, ask, button, answers, text } = await setup();
    await ask();

    expect(text('.address-prompt__title')).toEqual(['Зберегти картку?']);
    expect(text('.address-prompt__line')).toEqual(['Visa •••• 4242', 'Термін дії 07/28', 'IVAN PETRENKO']);
    expect(element.textContent).not.toMatch(/\d{8}/);
    button('Зберегти')?.click();
    await stable();
    expect(answers()).toEqual([[5, true]]);
  });

  it('should offer to update a card and save nothing for «Not now»', async () => {
    const { ask, button, answers, text } = await setup();
    await ask({ update: true, holder: '', month: 0, year: 0 });

    expect(text('.address-prompt__title')).toEqual(['Оновити картку?']);
    expect(text('.address-prompt__line')).toEqual(['Visa •••• 4242']);
    button('Не зараз')?.click();
    expect(answers()).toEqual([[5, false]]);
  });
});
