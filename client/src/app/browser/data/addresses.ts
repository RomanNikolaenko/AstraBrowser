import { Injectable, computed, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Address, AddressFields, AddressSettings, AddressesState, commands } from '../../bindings';

export type { Address, AddressFields, AddressSettings, AddressesState };

type Commands = typeof commands;
/** Команди server/src/addresses.rs, якими користується сховище (bindings.ts). */
export type AddressCommand =
  'addressesState' | 'addressSave' | 'addressRemove' | 'addressesSetSettings' | 'addressPromptAnswer' | 'addressAutofill';
export type AddressCommandArgs<K extends AddressCommand> = Parameters<Commands[K]>;
export type AddressCommandResult<K extends AddressCommand> = ReturnType<Commands[K]>;

/** «Зберегти адресу?» після надсилання форми на сайті (server/src/addresses.rs, PromptEvent). */
export interface AddressPromptRequest {
  readonly id: number;
  /** Що збережеться: для оновлення — збережена адреса разом із новим із форми. */
  readonly fields: AddressFields;
  /** Та сама людина з новими даними — тоді «Оновити адресу?». */
  readonly update: boolean;
}

/** Вид поля форми на сайті (server/src/autofill-page.js). */
export type AutofillKind = keyof AddressFields | 'name' | 'street';

export const EMPTY_ADDRESS: AddressFields = {
  given: '',
  family: '',
  organization: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postal: '',
  country: '',
  phone: '',
  email: '',
};

/** Ім'я й прізвище разом. */
export function fullName(fields: AddressFields): string {
  return [fields.given, fields.family].filter((part) => part.trim()).join(' ');
}

/** Значення адреси для поля форми виду `kind` (як addresses.rs, AddressFields::value). */
export function addressValue(fields: AddressFields, kind: AutofillKind): string {
  if (kind === 'name') {
    return fullName(fields);
  }
  if (kind === 'street') {
    return [fields.line1, fields.line2].filter((part) => part.trim()).join(', ');
  }
  return fields[kind].trim();
}

/** Адреса одним рядком: вулиця, квартира, місто, область, індекс, країна — що є. */
export function addressLine(fields: AddressFields): string {
  return [fields.line1, fields.line2, fields.city, fields.region, fields.postal, fields.country]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

/** Назва адреси в списках: ім'я, а без нього — організація, вулиця чи будь-що, що є. */
export function addressTitle(fields: AddressFields): string {
  return fullName(fields) || fields.organization.trim() || addressLine(fields) || fields.phone.trim() || fields.email.trim();
}

/**
 * Адреси для форм на сайтах. Самі адреси живуть у Rust (зашифровані DPAPI); тут — список, спільний для всіх вікон
 * (зміни приходять подією addresses://changed), і черга запитів «Зберегти адресу?». Поза Tauri адрес немає
 * (`state` — null).
 */
@Injectable({ providedIn: 'root' })
export class AddressesStore {
  protected readonly current = signal<AddressesState | null>(null);
  private readonly asking = signal<readonly AddressPromptRequest[]>([]);

  readonly state = this.current.asReadonly();
  readonly entries = computed(() => this.current()?.entries ?? []);
  readonly settings = computed(() => this.current()?.settings ?? null);
  /** Запити «Зберегти адресу?», що чекають відповіді, — по черзі. */
  readonly prompts = this.asking.asReadonly();

  constructor() {
    if (isTauri()) {
      void listen<AddressesState>('addresses://changed', ({ payload }) => this.current.set(payload));
      this.refresh().catch(() => undefined);
    }
  }

  async refresh(): Promise<void> {
    this.current.set(await this.call('addressesState'));
  }

  ask(request: AddressPromptRequest): void {
    this.asking.update((prompts) => [...prompts.filter((prompt) => prompt.id !== request.id), request]);
  }

  answer(id: number, save: boolean): Promise<void> {
    this.asking.update((prompts) => prompts.filter((prompt) => prompt.id !== id));
    return this.change('addressPromptAnswer', id, save);
  }

  /** Нова адреса (`id` — null) чи нові значення збереженої. */
  save(id: string | null, fields: AddressFields): Promise<void> {
    return this.change('addressSave', id, fields);
  }

  remove(id: string): Promise<void> {
    return this.change('addressRemove', id);
  }

  setSettings(settings: AddressSettings): Promise<void> {
    return this.change('addressesSetSettings', settings.offer, settings.autofill);
  }

  /** Заповнити форму на сайті `label` адресою `id` (вибрали в списку над полем). */
  async fill(label: string, id: string): Promise<void> {
    await this.call('addressAutofill', label, id);
  }

  /** Команда server/src/addresses.rs (bindings.ts); тести підміняють її, щоб обійтися без Rust. */
  protected call<K extends AddressCommand>(command: K, ...args: AddressCommandArgs<K>): AddressCommandResult<K> {
    const run = commands[command] as (...args: AddressCommandArgs<K>) => AddressCommandResult<K>;
    return run(...args);
  }

  private async change<K extends AddressCommand>(command: K, ...args: AddressCommandArgs<K>): Promise<void> {
    await this.call(command, ...args);
    await this.refresh();
  }
}
