import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input } from '@angular/core';
import { IconRegistry } from './icon-registry';

@Component({
  selector: 'app-icon',
  template: '',
  styleUrl: './ui-icon.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
  },
})
export class UiIcon {
  readonly icon = input<string>();

  private readonly icons = inject(IconRegistry);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect((onCleanup) => {
      const iconName = this.icon();
      if (!iconName) {
        this.el.nativeElement.innerHTML = '';
        return;
      }

      // Відписка і при зміні назви, і при знищенні: відповідь для старої назви не перезапише нову.
      const subscription = this.icons.get(iconName).subscribe((svg) => {
        this.el.nativeElement.innerHTML = svg;
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
