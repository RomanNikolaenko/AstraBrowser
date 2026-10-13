import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  AddressCommand,
  AddressCommandArgs,
  AddressCommandResult,
  AddressPromptRequest,
  AddressesStore,
  EMPTY_ADDRESS,
} from '../data/addresses';
import { AddressPrompt } from './address-prompt';

/** Без Rust: відповіді лише записуються. */
class FakeAddresses extends AddressesStore {
  readonly calls: [AddressCommand, readonly unknown[]][] = [];

  protected override call<K extends AddressCommand>(command: K, ...args: AddressCommandArgs<K>): AddressCommandResult<K> {
    this.calls.push([command, args]);
    return Promise.resolve(command === 'addressesState' ? null : undefined) as AddressCommandResult<K>;
  }
}

describe('AddressPrompt', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [AddressPrompt],
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: AddressesStore, useClass: FakeAddresses }],
    }).compileComponents();
    const store = TestBed.inject(AddressesStore) as FakeAddresses;
    const fixture = TestBed.createComponent(AddressPrompt);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const stable = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      await fixture.whenStable();
    };
    const ask = async (request: Partial<AddressPromptRequest> = {}) => {
      store.ask({
        id: 3,
        fields: {
          ...EMPTY_ADDRESS,
          given: 'Іван',
          family: 'Петренко',
          line1: 'вул. Хрещатик, 1',
          city: 'Київ',
          phone: '0671234567',
        },
        update: false,
        ...request,
      });
      await stable();
    };
    const button = (label: string) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label);
    const answers = () => store.calls.filter(([command]) => command === 'addressPromptAnswer').map(([, args]) => args);
    const text = (selector: string) => [...element.querySelectorAll(selector)].map((node) => node.textContent?.trim());
    return { store, stable, ask, button, answers, text };
  };

  it('should show what will be saved and save it', async () => {
    const { store, stable, ask, button, answers, text } = await setup();
    await ask();

    expect(text('.address-prompt__title')).toEqual(['Зберегти адресу?']);
    expect(text('.address-prompt__line')).toEqual(['Іван Петренко', 'вул. Хрещатик, 1, Київ', '0671234567']);
    button('Зберегти')?.click();
    await stable();

    expect(answers()).toEqual([[3, true]]);
    expect(store.prompts()).toEqual([]);
  });

  it('should ask about updates and the next address in turn', async () => {
    const { stable, ask, button, answers, text } = await setup();
    await ask({ update: true });
    await ask({ id: 4, fields: { ...EMPTY_ADDRESS, organization: 'ТОВ «Астра»', city: 'Львів', postal: '79000' } });

    expect(text('.address-prompt__title')).toEqual(['Оновити адресу?']);
    button('Не зараз')?.click();
    await stable();

    expect(text('.address-prompt__line')).toEqual(['ТОВ «Астра»', 'Львів, 79000']);
    button('Зберегти')?.click();
    expect(answers()).toEqual([
      [3, false],
      [4, true],
    ]);
  });
});
