// Випуск оновлення: npm run release -- "Що нового" (чи RELEASE_NOTES у середовищі)
//
// Збирає інсталятор NSIS, підписаний ключем оновлень (%USERPROFILE%\.tauri\astra-browser.key або
// TAURI_SIGNING_PRIVATE_KEY — шлях чи сам ключ), і пише поруч latest.json — його читає кнопка «Оновити Astra Browser»
// (server/src/updates.rs). Зазвичай це робить GitHub Actions (.github/workflows/release.yml) і сам публікує реліз;
// вручну обидва файли — у реліз з тегом v<версія> (RELEASING.md).
// Версію перед випуском піднімають у server/tauri.conf.json ("version").
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
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

const build = spawnSync('npm run tauri:build -- --bundles nsis --config tauri.updater.conf.json', {
  cwd: join(root, 'client'),
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    TAURI_SIGNING_PRIVATE_KEY: key,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  },
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const bundle = join(root, 'server/target/release/bundle/nsis');
const installer = `${config.productName}_${config.version}_x64-setup.exe`;
// Файли релізу — окремо й без пробілів у назвах: GitHub замінює їх крапками, і посилання з latest.json не збіглося б.
const release = join(root, 'server/target/release/bundle/release');
const asset = installer.replaceAll(' ', '-');
rmSync(release, { recursive: true, force: true });
mkdirSync(release, { recursive: true });
copyFileSync(join(bundle, installer), join(release, asset));
const manifest = {
  version: config.version,
  notes: process.env.RELEASE_NOTES?.trim() || process.argv.slice(2).join(' ') || undefined,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: readFileSync(join(bundle, `${installer}.sig`), 'utf8').trim(),
      url: `${repository}/releases/download/${tag}/${encodeURIComponent(asset)}`,
    },
  },
};
writeFileSync(join(release, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nВерсія ${config.version} готова. GitHub → Releases → Draft a new release, тег ${tag}, файли з ${release}:`);
console.log(`  ${asset}`);
console.log('  latest.json');
console.log(`${repository}/releases/new?tag=${tag}`);
