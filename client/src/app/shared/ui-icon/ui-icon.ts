import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, of } from 'rxjs';

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
  readonly name = input<string>();

  private readonly http = inject(HttpClient);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    effect(() => {
      const iconName = this.name();
      if (!iconName) {
        this.el.nativeElement.innerHTML = '';
        return;
      }

      const path = `assets/icons/${iconName}.svg`;

      this.http
        .get(path, { responseType: 'text' })
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          catchError((err) => {
            console.error(`Error loading icon: ${path}`, err);
            return of('');
          }),
        )
        .subscribe((svg) => {
          this.el.nativeElement.innerHTML = svg;
        });
    });
  }
}
