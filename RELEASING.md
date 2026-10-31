# Випуск оновлень Astra Browser

Кнопка «Оновити Astra Browser» у меню ☰ читає `latest.json` з останнього релізу цього репозиторію:
`https://github.com/RomanNikolaenko/AstraBrowser/releases/latest/download/latest.json` (`server/tauri.conf.json` →
`plugins.updater.endpoints`). Браузери перевіряють його за 10 секунд після запуску й далі раз на добу.

## Ключ підпису

Оновлення приймається лише з підписом ключа, публічна частина якого — у `server/tauri.conf.json`
(`plugins.updater.pubkey`). Приватний ключ — `%USERPROFILE%\.tauri\astra-browser.key`.

- Збережіть його копію (менеджер паролів, флешка): без нього встановлені браузери нових версій уже не приймуть.
- У git його не додавати.

### Один раз: ключ у секрети GitHub

1. Скопіювати ключ у буфер обміну (PowerShell):

   ```powershell
   Get-Content "$env:USERPROFILE\.tauri\astra-browser.key" -Raw | Set-Clipboard
   ```

2. GitHub → репозиторій → Settings → Secrets and variables → Actions → **New repository secret**:
   Name — `TAURI_SIGNING_PRIVATE_KEY`, Secret — вставити. Пароля в ключа немає, другий секрет не потрібен.

## Випуск версії (GitHub Actions)

1. Підняти `"version"` у `server/tauri.conf.json` (напр. `0.1.0` → `0.2.0`), закомітити й запушити.
2. Поставити тег із тією самою версією й описом змін і запушити його:

   ```bash
   git tag -a v0.2.0 -m "Що нового"
   ```

   ```bash
   git push origin v0.2.0
   ```

3. GitHub → Actions → **Release**: збирає інсталятор на Windows і пакети на Linux (Ubuntu 22.04), підписує й
   публікує реліз `v0.2.0` з `Astra-Browser_0.2.0_x64-setup.exe`, `Astra-Browser_0.2.0_amd64.deb`,
   `Astra-Browser-0.2.0-1.x86_64.rpm`, `Astra-Browser_0.2.0_amd64.AppImage` і одним `latest.json` на обидві системи.
   Перша збірка — ~20 хв, далі швидше (кеш).

Тег, що не збігається з версією в `server/tauri.conf.json`, workflow зупиняє з поясненням.

## Вручну (без Actions)

1. Підняти версію, як вище.
2. У теці `client`: `pnpm run release "Що нового"` — підписані пакети системи, на якій запущено (у Windows —
   інсталятор, у Linux — .deb, .rpm і AppImage), і `latest.json` у `server/target/release/bundle/release`. Щоб
   оновлювалися обидві системи, зберіть на кожній і складіть latest.json в один:
   `node scripts/release.mjs --merge <куди> <тека Windows> <тека Linux>`.
3. GitHub → Releases → **Draft a new release**: тег `v<версія>`, перетягнути всі файли, **Publish release**
   (не Pre-release: такий GitHub не вважає останнім).

## Хто оновлюється

Лише браузери, встановлені інсталятором чи пакетом з релізу. У Linux AppImage оновлюється сам, а .deb і .rpm —
через `dpkg`/`rpm`, для чого система попросить пароль. Запущений `tauri:dev` кнопку показує, але не оновлюється.
