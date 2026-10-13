import { Injectable, computed, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { CardInfo, CardInput, CardSettings, CardsState, commands } from '../../bindings';
import { tr, translate } from '../../shared/i18n/i18n';

export type { CardInfo, CardInput, CardSettings, CardsState };

type Commands = typeof commands;
/** Команди server/src/cards.rs, якими користується сховище (bindings.ts). */
export type CardCommand = 'cardsState' | 'cardSave' | 'cardRemove' | 'cardsSetSettings' | 'cardPromptAnswer' | 'cardAutofill';
export type CardCommandArgs<K extends CardCommand> = Parameters<Commands[K]>;
export type CardCommandResult<K extends CardCommand> = ReturnType<Commands[K]>;

/** «Зберегти картку?» після оплати на сайті (server/src/cards.rs, PromptEvent) — без номера. */
export interface CardPromptRequest {
  readonly id: number;
  readonly brand: string;
  readonly last4: string;
  readonly holder: string;
  /** 0 — у формі терміну не було. */
  readonly month: number;
  readonly year: number;
  /** Ця картка вже збережена, а тепер з іншим терміном чи іменем — тоді «Оновити картку?». */
  readonly update: boolean;
}

/** Картка в списках і запитаннях: те, що на ній видно. */
export interface CardFace {
  readonly brand: string;
  readonly last4: string;
  readonly month: number;
  readonly year: number;
  readonly nickname?: string;
}

const BRANDS: Readonly<Record<string, string>> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  prostir: tr('ПРОСТІР'),
  maestro: 'Maestro',
  unionpay: 'UnionPay',
  jcb: 'JCB',
  discover: 'Discover',
  diners: 'Diners Club',
};

/** Назва платіжної системи; невідома — просто «Картка». */
export function brandName(brand: string): string {
  return translate(BRANDS[brand] ?? tr('Картка'));
}

/** «Visa •••• 4242» чи назва, яку дали картці. */
export function cardTitle(card: CardFace): string {
  return card.nickname?.trim() || `${brandName(card.brand)} •••• ${card.last4}`;
}

/** Термін дії: «07/28»; без терміну — порожньо. */
export function cardExpiry(card: CardFace): string {
  return card.month && card.year ? `${String(card.month).padStart(2, '0')}/${String(card.year % 100).padStart(2, '0')}` : '';
}

/** Термін дії минув (картка дійсна до кінця свого місяця). */
export function cardExpired(card: CardFace, now = new Date()): boolean {
  return !!card.month && !!card.year && new Date(card.year, card.month, 1) <= now;
}

/**
 * Банківські картки для форм оплати. Самі номери живуть у Rust (зашифровані DPAPI) й сюди не приходять — лише
 * платіжна система й останні чотири цифри. Список спільний для всіх вікон (зміни приходять подією cards://changed),
 * тут же — черга запитів «Зберегти картку?». Поза Tauri карток немає (`state` — null).
 */
@Injectable({ providedIn: 'root' })
export class CardsStore {
  protected readonly current = signal<CardsState | null>(null);
  private readonly asking = signal<readonly CardPromptRequest[]>([]);

  readonly state = this.current.asReadonly();
  readonly entries = computed(() => this.current()?.entries ?? []);
  readonly settings = computed(() => this.current()?.settings ?? null);
  /** Чи налаштовано Windows Hello — без нього підтверджувати нічим. */
  readonly hello = computed(() => this.current()?.hello ?? false);
  /** Запити «Зберегти картку?», що чекають відповіді, — по черзі. */
  readonly prompts = this.asking.asReadonly();

  constructor() {
    if (isTauri()) {
      void listen<CardsState>('cards://changed', ({ payload }) => this.current.set(payload));
      this.refresh().catch(() => undefined);
    }
  }

  async refresh(): Promise<void> {
    this.current.set(await this.call('cardsState'));
  }

  ask(request: CardPromptRequest): void {
    this.asking.update((prompts) => [...prompts.filter((prompt) => prompt.id !== request.id), request]);
  }

  answer(id: number, save: boolean): Promise<void> {
    this.asking.update((prompts) => prompts.filter((prompt) => prompt.id !== id));
    return this.change('cardPromptAnswer', id, save);
  }

  /** Нова картка (`id` — null) чи нові дані збереженої; порожній номер під час зміни лишає той самий. */
  save(id: string | null, card: CardInput): Promise<void> {
    return this.change('cardSave', id, card);
  }

  remove(id: string): Promise<void> {
    return this.change('cardRemove', id);
  }

  setSettings(settings: CardSettings): Promise<void> {
    return this.change('cardsSetSettings', settings.offer, settings.autofill, settings.verify);
  }

  /** Заповнити форму на сайті `label` карткою `id`; false — підтвердження через Windows Hello не пройшло. */
  fill(label: string, id: string): Promise<boolean> {
    return this.call('cardAutofill', label, id);
  }

  /** Команда server/src/cards.rs (bindings.ts); тести підміняють її, щоб обійтися без Rust. */
  protected call<K extends CardCommand>(command: K, ...args: CardCommandArgs<K>): CardCommandResult<K> {
    const run = commands[command] as (...args: CardCommandArgs<K>) => CardCommandResult<K>;
    return run(...args);
  }

  private async change<K extends CardCommand>(command: K, ...args: CardCommandArgs<K>): Promise<void> {
    await this.call(command, ...args);
    await this.refresh();
  }
}
