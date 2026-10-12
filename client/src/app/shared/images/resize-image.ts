import { translate } from '../i18n/i18n';
/** Як вписати зображення: `cover` — заповнити рамку й обрізати зайве (аватар), `contain` — уміститися цілим (фон). */
export type ResizeFit = 'cover' | 'contain';

/**
 * Зменшує вибране зображення до `width`×`height` і повертає JPEG як data: URL — щоб невелике зберігалося
 * в localStorage (фото профілю, фон нової вкладки), а не мегабайти з камери.
 */
export async function resizeImage(file: Blob, width: number, height: number, fit: ResizeFit, quality = 0.85): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error(translate('Це не зображення')));
      element.src = url;
    });
    const scale =
      fit === 'cover'
        ? Math.max(width / image.naturalWidth, height / image.naturalHeight)
        : Math.min(1, width / image.naturalWidth, height / image.naturalHeight);
    const drawn = { width: Math.round(image.naturalWidth * scale), height: Math.round(image.naturalHeight * scale) };
    const canvas = document.createElement('canvas');
    canvas.width = fit === 'cover' ? width : drawn.width;
    canvas.height = fit === 'cover' ? height : drawn.height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error(translate('Не вдалося обробити зображення'));
    }
    context.drawImage(image, (canvas.width - drawn.width) / 2, (canvas.height - drawn.height) / 2, drawn.width, drawn.height);
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(url);
  }
}
