import { Injectable, inject, signal } from '@angular/core';
import { isTauri } from '@tauri-apps/api/core';
import { commands } from '../../bindings';
import { UiSelectOption } from '../../shared/ui-select/ui-select';
import { SessionStore } from '../session/session';

/** Режим DNS через HTTPS (server/src/dns.rs, Mode). */
export type DnsMode = 'default' | 'increased' | 'max' | 'off';
export type DnsProvider = 'cloudflare' | 'google' | 'quad9' | 'adguard' | 'custom';

export interface DnsSettings {
  readonly mode: DnsMode;
  readonly provider: DnsProvider;
  /** Адреса власного постачальника (https://…), якщо `provider` — custom. */
  readonly custom: string;
}

interface DnsState {
  readonly settings: DnsSettings;
  /** Збережене ще не діє: браузер треба перезапустити. */
  readonly restartNeeded: boolean;
}

export const DNS_MODES: readonly { readonly value: DnsMode; readonly label: string; readonly hint: string }[] = [
  {
    value: 'default',
    label: 'Типовий захист',
    hint: 'Захищений DNS, якщо його підтримує ваш постачальник DNS. Інакше — звичайний.',
  },
  {
    value: 'increased',
    label: 'Посилений захист',
    hint: 'Завжди через вибраного постачальника, а якщо він недоступний — звичайний DNS.',
  },
  {
    value: 'max',
    label: 'Максимальний захист',
    hint: 'Лише захищений DNS. Якщо постачальник недоступний, сайти не відкриватимуться.',
  },
  { value: 'off', label: 'Вимкнено', hint: 'Звичайний DNS вашої мережі чи інтернет-провайдера.' },
];

export const DNS_PROVIDERS: readonly UiSelectOption<DnsProvider>[] = [
  { value: 'cloudflare', label: 'Cloudflare' },
  { value: 'google', label: 'Google Public DNS' },
  { value: 'quad9', label: 'Quad9 — блокує шкідливі сайти' },
  { value: 'adguard', label: 'AdGuard DNS — блокує рекламу' },
  { value: 'custom', label: 'Власний…' },
];

/**
 * DNS через HTTPS — налаштування цього комп'ютера (server/src/dns.rs). Браузер читає його лише під час запуску,
 * тож нове діє після перезапуску (`restartNeeded`). Поза застосунком (ng serve) його немає.
 */
@Injectable({ providedIn: 'root' })
export class DnsStore {
  readonly available = isTauri();
  private readonly session = inject(SessionStore);
  /** null — ще не прочитано. */
  readonly state = signal<DnsState | null>(null);

  async load(): Promise<void> {
    if (this.available) {
      this.state.set(await commands.dnsSettings());
    }
  }

  async save(settings: DnsSettings): Promise<void> {
    this.state.set(await commands.dnsSet(settings));
  }

  /** Перезапуск браузера: вікна закриваються й відкриваються знову — з тими самими вкладками. */
  async restart(): Promise<void> {
    this.session.restoreOnce();
    await commands.dnsRestart();
  }
}
