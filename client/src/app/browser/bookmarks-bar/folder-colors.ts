import { BookmarkFolder, FOLDER_COLORS, FolderColor } from '../data/bookmarks';

/** Відтінки тек — помітні і на світлій, і на темній темі. */
const SHADES: Record<FolderColor, { readonly label: string; readonly value: string }> = {
  red: { label: 'Червоний', value: '#e5484d' },
  orange: { label: 'Помаранчевий', value: '#f76b15' },
  yellow: { label: 'Жовтий', value: '#e2a336' },
  green: { label: 'Зелений', value: '#30a46c' },
  teal: { label: 'Бірюзовий', value: '#12a594' },
  blue: { label: 'Синій', value: '#3e7bfa' },
  purple: { label: 'Фіолетовий', value: '#8e4ec6' },
  pink: { label: 'Рожевий', value: '#d6409f' },
};

/** Палітра для вибору кольору теки — у порядку FOLDER_COLORS. */
export const FOLDER_PALETTE = FOLDER_COLORS.map((color) => ({ color, ...SHADES[color] }));

/** Кольорова тека — заповнена своїм кольором, звичайна — контурна. */
export function folderIcon(folder: BookmarkFolder): string {
  return folder.color ? 'folder-filled' : 'folder';
}

/** Колір іконки теки; null — як у решти іконок панелі. */
export function folderColor(folder: BookmarkFolder): string | null {
  return folder.color ? SHADES[folder.color].value : null;
}
