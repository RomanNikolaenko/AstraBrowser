/**
 * Stylelint: один вигляд стилів у всьому проєкті.
 * Перевірка — `npm run lint:styles`, виправлення того, що можна виправити автоматично, — `npm run lint:styles:fix`.
 * Пробіли й відступи — справа Prettier; тут правила SCSS і порядок властивостей.
 *
 * @type {import('stylelint').Config}
 */
export default {
  extends: [
    // Загальноприйняті правила для SCSS.
    'stylelint-config-standard-scss',
    // Один порядок властивостей: розташування → блок → типографіка → вигляд → анімація.
    'stylelint-config-recess-order',
  ],
  rules: {
    // Класи — за BEM: block, block__element, block--modifier, block__element--modifier (усе в kebab-case).
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$',
      { message: (selector) => `Клас "${selector}" має бути в BEM: block__element--modifier (kebab-case)` },
    ],
  },
};
