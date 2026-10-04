import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { resizeImage } from '../../../shared/images/resize-image';
import { ACCENT_COLORS, SettingsStore, ThemePreference } from '../../../shared/settings/settings';
import { UiIcon } from '../../../shared/ui-icon/ui-icon';
import { NEW_TAB_BACKGROUNDS, newTabBackgroundCss } from '../../new-tab/new-tab-backgrounds';

/** Найбільший розмір свого фону: досить для екрана й не забагато для localStorage. */
const IMAGE_WIDTH = 1920;
const IMAGE_HEIGHT = 1200;

/**
 * Сторінка «Персоналізація» (astra://personalization): тема, колір акценту інтерфейсу, фон нової вкладки
 * (набори чи своє зображення).
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UiIcon],
  selector: 'app-personalization-page',
  styleUrls: ['../internal-page.scss', './personalization-page.scss'],
  templateUrl: './personalization-page.html',
})
export class PersonalizationPage {
  protected readonly settings = inject(SettingsStore);

  protected readonly themes: readonly { readonly value: ThemePreference; readonly label: string; readonly icon: string }[] = [
    { value: 'system', label: 'Як у системі', icon: 'monitor' },
    { value: 'light', label: 'Світла', icon: 'sun' },
    { value: 'dark', label: 'Темна', icon: 'moon' },
  ];
  protected readonly accents = ACCENT_COLORS;
  protected readonly backgrounds = NEW_TAB_BACKGROUNDS;
  protected readonly customPreview = computed(() => newTabBackgroundCss('custom', this.settings.newTabImage()));
  protected readonly imageError = signal<string | null>(null);

  protected async chooseImage(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }
    this.imageError.set(null);
    try {
      this.settings.newTabImage.set(await resizeImage(file, IMAGE_WIDTH, IMAGE_HEIGHT, 'contain', 0.82));
      this.settings.newTabBackground.set('custom');
    } catch {
      this.imageError.set('Не вдалося відкрити це зображення. Виберіть картинку у форматі JPEG, PNG чи WebP.');
    }
  }

  protected removeImage(): void {
    this.settings.newTabImage.set('');
    if (this.settings.newTabBackground() === 'custom') {
      this.settings.newTabBackground.set('bubbles');
    }
  }
}
