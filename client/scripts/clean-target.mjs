// Прибирання server/target перед збіркою Rust — його самі запускають pnpm run tauri:dev і tauri:build (package.json).
//
// Cargo старих збірок не видаляє ніколи: кожна версія компілятора чи залежностей і кожен режим (dev, тести, Clippy,
// реліз) лишають у target свої файли, і за місяць тека виростала до 60 ГБ. Тож:
// - кеш інкрементальної компіляції (<профіль>/incremental), який не оновлювався STALE_DAYS днів, видаляється — це
//   кеш старих версій і режимів; найсвіжіший кеш кожного крейта лишається, хоч би й давній: без нього крейт
//   перекомпілювався б цілком;
// - якщо target і тоді більший за LIMIT_GB, видаляється весь, як cargo clean: наступна збірка — з нуля (кілька хвилин).
// На CI нічого не робить: там збирають на чистій машині. Інша тека — аргументом: node scripts/clean-target.mjs <тека>.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const STALE_DAYS = 7;
const LIMIT_GB = 25;
const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

const target = resolve(process.argv[2] ?? join(import.meta.dirname, '../../server/target'));
if (process.env.CI || !existsSync(target)) {
  process.exit(0);
}

/** Теки всередині `dir` (порожньо, якщо її немає). */
function dirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

/** Коли теку змінювали востаннє: її саму чи те, що в ній одразу (сесії rustc). */
function modified(dir) {
  return readdirSync(dir).reduce((latest, name) => Math.max(latest, statSync(join(dir, name)).mtimeMs), statSync(dir).mtimeMs);
}

function size(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      total += statSync(join(entry.parentPath, entry.name)).size;
    }
  }
  return total;
}

/** Видаляє теку; зайнятий файл (скажімо, ще запущений astra-browser.exe) — не перешкода: Cargo збере, чого бракує. */
function remove(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
  } catch (error) {
    console.warn(`target: не все видалено (${error.code ?? error.message})`);
  }
}

const gb = (bytes) => (bytes / GB).toFixed(1);

// <профіль>/incremental і <ціль>/<профіль>/incremental (збірки під іншу систему).
const caches = [...dirs(target), ...dirs(target).flatMap(dirs)]
  .map((dir) => join(dir, 'incremental'))
  .filter((dir) => existsSync(dir));
const stale = [];
for (const cache of caches) {
  const crates = Map.groupBy(
    dirs(cache).map((dir) => ({ dir, time: modified(dir) })),
    ({ dir }) => basename(dir).replace(/-[^-]+$/, '')
  );
  for (const versions of crates.values()) {
    const newest = Math.max(...versions.map(({ time }) => time));
    stale.push(...versions.filter(({ time }) => time < newest && Date.now() - time > STALE_DAYS * DAY).map(({ dir }) => dir));
  }
}
if (stale.length) {
  const freed = stale.reduce((total, dir) => total + size(dir), 0);
  stale.forEach(remove);
  console.log(`target: видалено застарілий кеш компіляції (тек: ${stale.length}, ${gb(freed)} ГБ)`);
}

const total = size(target);
if (total > LIMIT_GB * GB) {
  remove(target);
  console.log(`target: ${gb(total)} ГБ — більше за ${LIMIT_GB} ГБ, видалено весь; Rust збирається з нуля (кілька хвилин)`);
}
