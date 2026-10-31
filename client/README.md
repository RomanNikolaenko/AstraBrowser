# AstraBrowser

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.0.

## Перевірки коду

Залежності — `pnpm install` (pnpm 12, версія — `packageManager` у `package.json`). Те саме, що тут, запускає CI
(`.github/workflows/ci.yml`).

| Що                                                 | Команда                                                          | Налаштування                       |
| -------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------- |
| Форматування TS/JS/HTML/SCSS/JSON (Oxfmt)          | `pnpm run format` / `pnpm run format:check`                      | `.oxfmtrc.json`                    |
| Загальні правила JS/TS (Oxlint)                    | `pnpm run lint:ox` / `pnpm run lint:ox:fix`                      | `.oxlintrc.json`                   |
| Правила Angular для TS і шаблонів (angular-eslint) | `pnpm run lint` / `pnpm run lint:fix`                            | `eslint.config.js`                 |
| SCSS (Stylelint)                                   | `pnpm run lint:styles` / `pnpm run lint:styles:fix`              | `stylelint.config.mjs`             |
| Вразливості залежностей інтерфейсу (pnpm audit)    | `pnpm audit --prod`                                              | `pnpm-workspace.yaml`              |
| Форматування Rust (rustfmt)                        | `cargo fmt` / `cargo fmt --check` у `server/`                    | `server/rustfmt.toml`              |
| Лінтер Rust (Clippy)                               | `cargo clippy --all-targets -- -D warnings` і з `--release`      | —                                  |
| Вразливості залежностей Rust (cargo-audit)         | `cargo audit` у `server/` (`cargo install cargo-audit --locked`) | —                                  |
| Дозволи інтерфейсу (Tauri capabilities)            | перевіряються під час збірки Rust                                | `server/capabilities/default.json` |

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
