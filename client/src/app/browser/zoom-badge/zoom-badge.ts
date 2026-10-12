import { ChangeDetectionStrategy, Component, computed, model, viewChild } from '@angular/core';
import { UiIcon } from '../../shared/ui-icon/ui-icon';
import { Popover } from '../popover/popover';
import { DEFAULT_ZOOM, canZoomIn, canZoomOut, zoomIn, zoomOut } from '../zoom';
import { TranslatePipe } from '../../shared/i18n/i18n';

/**
 * Масштаб в адресному рядку, як в Edge: плашка «90%» видно лише тоді, коли масштаб не 100%.
 * Клік по ній — панель із «−», «+» і «Скинути»; скинули — плашка зникає разом із панеллю.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Popover, TranslatePipe, UiIcon],
  selector: 'app-zoom-badge',
  styleUrl: './zoom-badge.scss',
  template: `
    <!-- Поки панель відкрита, плашка лишається й на 100%: інакше панель утратила б свій якір. -->
    @if (changed() || popover()?.isOpen()) {
      <button
        class="zoom-badge"
        type="button"
        popovertarget="zoom-popover"
        [attr.aria-label]="'Масштаб {0}%' | t: [zoom()]"
        [title]="'Масштаб {0}%' | t: [zoom()]">
        {{ zoom() }}%
      </button>
    }
    <app-popover class="zoom-popover" popoverId="zoom-popover" caret>
      <div class="zoom-popover__row">
        <span class="zoom-popover__label" id="zoom-popover-label">{{ 'Масштаб' | t }}</span>
        <div class="zoom-popover__control" role="group" aria-labelledby="zoom-popover-label">
          <button
            class="zoom-popover__step"
            type="button"
            [attr.aria-label]="'Зменшити масштаб' | t"
            [title]="'Зменшити масштаб' | t"
            [disabled]="!canOut()"
            (click)="zoom.set(stepOut())">
            <app-icon icon="minus" />
          </button>
          <output class="zoom-popover__value" aria-live="polite">{{ zoom() }}%</output>
          <button
            class="zoom-popover__step"
            type="button"
            [attr.aria-label]="'Збільшити масштаб' | t"
            [title]="'Збільшити масштаб' | t"
            [disabled]="!canIn()"
            (click)="zoom.set(stepIn())">
            <app-icon icon="plus" />
          </button>
        </div>
        <button class="zoom-popover__reset" type="button" (click)="reset()">{{ 'Скинути' | t }}</button>
      </div>
    </app-popover>
  `,
})
export class ZoomBadge {
  readonly zoom = model(DEFAULT_ZOOM);

  protected readonly changed = computed(() => this.zoom() !== DEFAULT_ZOOM);
  protected readonly canIn = computed(() => canZoomIn(this.zoom()));
  protected readonly canOut = computed(() => canZoomOut(this.zoom()));

  protected readonly popover = viewChild(Popover);

  protected stepIn(): number {
    return zoomIn(this.zoom());
  }

  protected stepOut(): number {
    return zoomOut(this.zoom());
  }

  /** Знову 100%: плашки більше немає, тож і панель під нею закривається. */
  protected reset(): void {
    this.popover()?.hide();
    this.zoom.set(DEFAULT_ZOOM);
  }
}
