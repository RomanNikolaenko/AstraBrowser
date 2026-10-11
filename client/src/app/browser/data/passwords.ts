import { Injectable, computed, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { commands } from '../../bindings';

type Commands = typeof commands;
/** Команди server/src/passwords.rs, якими користується сховище (bindings.ts). */
export type PasswordCommand =
  | 'passwordsState'
  | 'passwordPromptAnswer'
  | 'passwordReveal'
  | 'passwordAdd'
  | 'passwordEdit'
  | 'passwordRemove'
  | 'passwordsNeverRemove'
  | 'passwordsSetSettings';
export type PasswordCommandArgs<K extends PasswordCommand> = Parameters<Commands[K]>;
export type PasswordCommandResult<K extends PasswordCommand> = ReturnType<Commands[K]>;

/** Збережений пароль — без самого пароля (server/src/passwords.rs, PasswordInfo). */
export interface SavedPassword {
  readonly id: string;
  /** https://example.com — пароль підставляється лише сторінкам цього сайту. */
  readonly origin: string;
  readonly username: string;
  readonly created: number;
  readonly updated: number;
  /** Коли пароль востаннє підставили на сайті. */
  readonly used: number | null;
}

export interface PasswordSettings {
  /** Пропонувати зберегти пароль після входу на сайт. */
  readonly offer: boolean;
  /** Показувати збережені облікові записи в полях входу на сайтах. */
  readonly autofill: boolean;
}

export interface PasswordsState {
  readonly entries: readonly SavedPassword[];
  /** Сайти (origin), для яких паролі не пропонується зберігати. */
  readonly never: readonly string[];
  readonly settings: PasswordSettings;
}

/** «Зберегти пароль?» після входу на сайт (server/src/passwords.rs, PromptEvent). */
export interface PasswordPromptRequest {
  readonly id: number;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  /** Для цього імені вже збережено інший пароль — тоді «Оновити пароль?». */
  readonly update: boolean;
}

/** Що відповіли на «Зберегти пароль?»: зберегти, ніколи для цього сайту чи не зараз. */
export type PasswordPromptChoice = 'save' | 'never' | 'dismiss';

/**
 * Паролі сайтів. Самі паролі живуть у Rust (зашифровані DPAPI); тут — список без паролів, спільний для всіх
 * вікон (зміни приходять подією passwords://changed), і черга запитів «Зберегти пароль?».
 * Поза Tauri паролів немає (`state` — null).
 */
@Injectable({ providedIn: 'root' })
export class PasswordsStore {
  protected readonly current = signal<PasswordsState | null>(null);
  private readonly asking = signal<readonly PasswordPromptRequest[]>([]);

  readonly state = this.current.asReadonly();
  readonly entries = computed(() => this.current()?.entries ?? []);
  readonly never = computed(() => this.current()?.never ?? []);
  readonly settings = computed(() => this.current()?.settings ?? null);
  /** Запити «Зберегти пароль?», що чекають відповіді, — по черзі. */
  readonly prompts = this.asking.asReadonly();

  constructor() {
    if (isTauri()) {
      void listen<PasswordsState>('passwords://changed', ({ payload }) => this.current.set(payload));
      this.refresh().catch(() => undefined);
    }
  }

  async refresh(): Promise<void> {
    this.current.set(await this.call('passwordsState'));
  }

  ask(request: PasswordPromptRequest): void {
    this.asking.update((prompts) => [...prompts.filter((prompt) => prompt.id !== request.id), request]);
  }

  /** Відповідь на «Зберегти пароль?»; зберігаються ім'я й пароль, які лишилися в полях вікна. */
  answer(id: number, choice: PasswordPromptChoice, username?: string, password?: string): Promise<void> {
    this.asking.update((prompts) => prompts.filter((prompt) => prompt.id !== id));
    return this.change('passwordPromptAnswer', id, choice, username ?? null, password ?? null);
  }

  /** Сам пароль — щоб показати чи скопіювати. */
  reveal(id: string): Promise<string> {
    return this.call('passwordReveal', id);
  }

  /** Пароль, доданий вручну; `site` — адреса як її ввели («example.com» теж підходить). */
  add(site: string, username: string, password: string): Promise<void> {
    return this.change('passwordAdd', site, username, password);
  }

  /** Нове ім'я чи пароль; порожній пароль лишає старий. */
  edit(id: string, username: string, password: string): Promise<void> {
    return this.change('passwordEdit', id, username, password);
  }

  remove(id: string): Promise<void> {
    return this.change('passwordRemove', id);
  }

  /** Сайт знову може пропонувати зберегти пароль. */
  allowSaving(origin: string): Promise<void> {
    return this.change('passwordsNeverRemove', origin);
  }

  setSettings(settings: PasswordSettings): Promise<void> {
    return this.change('passwordsSetSettings', settings.offer, settings.autofill);
  }

  /** Команда server/src/passwords.rs (bindings.ts); тести підміняють її, щоб обійтися без Rust. */
  protected call<K extends PasswordCommand>(command: K, ...args: PasswordCommandArgs<K>): PasswordCommandResult<K> {
    const run = commands[command] as (...args: PasswordCommandArgs<K>) => PasswordCommandResult<K>;
    return run(...args);
  }

  private async change<K extends PasswordCommand>(command: K, ...args: PasswordCommandArgs<K>): Promise<void> {
    await this.call(command, ...args);
    await this.refresh();
  }
}

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '-_.!?@#$%';

/** Надійний пароль: малі й великі літери, цифри й символи (без схожих на вигляд l, I, O, 0, 1). */
export function generatePassword(length = 16): string {
  const sets = [LOWER, UPPER, DIGITS, SYMBOLS];
  const all = sets.join('');
  const values = crypto.getRandomValues(new Uint32Array(length * 2));
  // Кожен вид символів — хоча б раз, решта — з усіх.
  const chars = [
    ...sets.map((set, index) => set[values[index] % set.length]),
    ...Array.from({ length: length - sets.length }, (_, index) => all[values[sets.length + index] % all.length]),
  ];
  // Перемішування Фішера — Єйтса: обов'язкові символи не стоять на початку.
  for (let index = chars.length - 1; index > 0; index--) {
    const other = values[length + index] % (index + 1);
    [chars[index], chars[other]] = [chars[other], chars[index]];
  }
  return chars.join('');
}
