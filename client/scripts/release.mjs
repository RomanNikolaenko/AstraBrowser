// Випуск оновлення: npm run release -- "Що нового" (чи RELEASE_NOTES у середовищі)
//
// Збирає для системи, на якій запущено, пакети, підписані ключем оновлень (%USERPROFILE%\.tauri\astra-browser.key або
// TAURI_SIGNING_PRIVATE_KEY — шлях чи сам ключ): у Windows — інсталятор NSIS, у Linux — .deb, .rpm і AppImage. Поруч
// пише latest.json — його читає кнопка «Оновити Astra Browser» (server/src/updates.rs). Зазвичай це робить GitHub
// Actions (.github/workflows/release.yml): збирає у Windows і в Linux, складає обидва latest.json в один
// (`node scripts/release.mjs --merge <куди> <тека>…`) і публікує реліз; вручну файли — у реліз з тегом v<версія>
// (RELEASING.md). Версію перед випуском піднімають у server/tauri.conf.json ("version").
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');

// Складає latest.json збірок різних систем в один (а їхні файли — в одну теку) для релізу.
if (process.argv[2] === '--merge') {
  const [into, ...parts] = process.argv.slice(3).map((dir) => resolve(dir));
  mkdirSync(into, { recursive: true });
  let merged = null;
  for (const part of parts) {
    const manifest = JSON.parse(readFileSync(join(part, 'latest.json'), 'utf8'));
    merged = merged ? { ...merged, platforms: { ...merged.platforms, ...manifest.platforms } } : manifest;
    for (const file of readdirSync(part).filter((name) => name !== 'latest.json')) {
      renameSync(join(part, file), join(into, file));
    }
  }
  writeFileSync(join(into, 'latest.json'), `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`latest.json: ${Object.keys(merged?.platforms ?? {}).join(', ')}`);
  process.exit(0);
}

const config = JSON.parse(readFileSync(join(root, 'server/tauri.conf.json'), 'utf8'));
// https://github.com/<власник>/<репозиторій>/releases/latest/download/latest.json
const repository = config.plugins.updater.endpoints[0].match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\//)?.[1];
if (!repository) {
  console.error('Адреса оновлень у server/tauri.conf.json (plugins.updater.endpoints) — не реліз на GitHub.');
  process.exit(1);
}
const tag = `v${config.version}`;
const key = process.env.TAURI_SIGNING_PRIVATE_KEY || join(homedir(), '.tauri', 'astra-browser.key');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !existsSync(key)) {
  console.error(
    `Немає ключа оновлень: ${key} (на GitHub — секрет TAURI_SIGNING_PRIVATE_KEY). ` +
      'Без нього встановлені браузери не приймуть оновлення.'
  );
  process.exit(1);
}

const linux = process.platform === 'linux';
const build = spawnSync(
  `npm run tauri:build -- --bundles ${linux ? 'deb,rpm,appimage' : 'nsis'} --config tauri.updater.conf.json`,
  {
    cwd: join(root, 'client'),
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      TAURI_SIGNING_PRIVATE_KEY: key,
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
    },
  }
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const bundles = join(root, 'server/target/release/bundle');
// Файли релізу — окремо й без пробілів у назвах: GitHub замінює їх крапками, і посилання з latest.json не збіглося б.
const release = join(bundles, 'release');
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
const platforms = {};
const assets = [];
/** Пакет `file` із теки `dir` — у реліз, а якщо його підписано — ще й у latest.json під ключами `keys`. */
const publish = (dir, file, keys) => {
  const asset = file.replaceAll(' ', '-');
  copyFileSync(join(bundles, dir, file), join(release, asset));
  assets.push(asset);
  const signature = join(bundles, dir, `${file}.sig`);
  if (!existsSync(signature)) {
    return;
  }
  const platform = {
    signature: readFileSync(signature, 'utf8').trim(),
    url: `${repository}/releases/download/${tag}/${encodeURIComponent(asset)}`,
  };
  for (const name of keys) {
    platforms[name] = platform;
  }
};
if (linux) {
  // Оновлення шукає {система}-{архітектура}-{пакет}, а без нього — {система}-{архітектура} (тоді AppImage).
  for (const [dir, extension, keys] of [
    ['appimage', '.AppImage', ['linux-x86_64-appimage', 'linux-x86_64']],
    ['deb', '.deb', ['linux-x86_64-deb']],
    ['rpm', '.rpm', ['linux-x86_64-rpm']],
  ]) {
    const file = readdirSync(join(bundles, dir)).find((name) => name.endsWith(extension) && name.includes(config.version));
    if (file) {
      publish(dir, file, keys);
    }
  }
} else {
  publish('nsis', `${config.productName}_${config.version}_x64-setup.exe`, ['windows-x86_64']);
}
const manifest = {
  version: config.version,
  notes: process.env.RELEASE_NOTES?.trim() || process.argv.slice(2).join(' ') || undefined,
  pub_date: new Date().toISOString(),
  platforms,
};
writeFileSync(join(release, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nВерсія ${config.version} готова. GitHub → Releases → Draft a new release, тег ${tag}, файли з ${release}:`);
for (const asset of assets) {
  console.log(`  ${asset}`);
}
console.log('  latest.json');
console.log(`${repository}/releases/new?tag=${tag}`);
