// Іконки інтерфейсу — у збірку: pnpm run icons (і pnpm run icons --check у CI)
//
// Пише src/app/shared/ui-icon/icons.ts: кожен файл src/assets/icons/*.svg імпортується як текст (angular.json →
// "loader": { ".svg": "text" }) і потрапляє в JS разом з інтерфейсом. Так іконки малюються одразу, без окремого
// запиту на кожну. --check — лише перевірити, що icons.ts відповідає файлам (додали іконку й не запустили скрипт).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const client = resolve(import.meta.dirname, '..');
const folder = join(client, 'src/assets/icons');
const output = join(client, 'src/app/shared/ui-icon/icons.ts');

const names = readdirSync(folder)
  .filter((file) => file.endsWith('.svg'))
  .map((file) => file.slice(0, -'.svg'.length))
  .sort();
// Суфікс — бо назва файлу буває словом мови (private.svg).
const variable = (name) => `${name.replace(/-(\w)/g, (_, letter) => letter.toUpperCase())}Svg`;

const source = [
  '// Згенеровано client/scripts/icons.mjs (pnpm run icons) — правте файли в src/assets/icons, а не цей файл.',
  ...names.map((name) => `import ${variable(name)} from '../../../assets/icons/${name}.svg';`),
  '',
  '/** Розмітка іконок за назвою файлу без .svg. */',
  'export const ICONS: Readonly<Record<string, string>> = {',
  ...names.map((name) => `  ${/^[a-z]\w*$/.test(name) ? name : `'${name}'`}: ${variable(name)},`),
  '};',
  '',
].join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(output, 'utf8');
  } catch {
    // Немає файла — теж застарів.
  }
  if (current !== source) {
    console.error('src/app/shared/ui-icon/icons.ts не відповідає src/assets/icons — запустіть pnpm run icons.');
    process.exit(1);
  }
  console.log(`Іконки на місці: ${names.length}.`);
} else {
  writeFileSync(output, source);
  console.log(`icons.ts: ${names.length} іконок.`);
}
