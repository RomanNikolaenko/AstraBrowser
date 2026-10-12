import { NewTabBackground } from '../../shared/settings/settings';
import { tr } from '../../shared/i18n/i18n';

/** Фони нової вкладки (Персоналізація): CSS-фон для ::before нової вкладки й для мініатюр вибору. */
export const NEW_TAB_BACKGROUNDS: readonly { readonly value: NewTabBackground; readonly label: string; readonly css: string }[] =
  [
    { value: 'bubbles', label: tr('Бульбашки'), css: 'var(--page-bubbles) center 35% / cover no-repeat' },
    {
      value: 'aurora',
      label: tr('Північне сяйво'),
      css:
        'radial-gradient(55% 50% at 22% 30%, rgb(56 189 248 / 60%), transparent 70%), ' +
        'radial-gradient(50% 45% at 78% 28%, rgb(124 58 237 / 60%), transparent 70%), ' +
        'radial-gradient(55% 50% at 55% 85%, rgb(16 185 129 / 45%), transparent 70%)',
    },
    {
      value: 'sunset',
      label: tr('Захід сонця'),
      css:
        'radial-gradient(55% 50% at 25% 30%, rgb(251 146 60 / 60%), transparent 70%), ' +
        'radial-gradient(50% 45% at 78% 40%, rgb(236 72 153 / 55%), transparent 70%), ' +
        'radial-gradient(50% 45% at 50% 90%, rgb(250 204 21 / 40%), transparent 70%)',
    },
    {
      value: 'ocean',
      label: tr('Океан'),
      css:
        'radial-gradient(55% 50% at 30% 30%, rgb(37 99 235 / 60%), transparent 70%), ' +
        'radial-gradient(55% 50% at 75% 60%, rgb(20 184 166 / 55%), transparent 70%)',
    },
    { value: 'none', label: tr('Без фону'), css: 'none' },
  ];

/** CSS-фон нової вкладки: один із наборів чи своє зображення (`image` — data: URL). */
export function newTabBackgroundCss(background: NewTabBackground, image: string): string {
  if (background === 'custom') {
    return image ? `url("${image}") center / cover no-repeat` : 'none';
  }
  return (NEW_TAB_BACKGROUNDS.find((item) => item.value === background) ?? NEW_TAB_BACKGROUNDS[0]).css;
}
