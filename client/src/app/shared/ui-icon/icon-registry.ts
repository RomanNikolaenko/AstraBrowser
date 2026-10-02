import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, of, shareReplay } from 'rxjs';

/** Завантажує SVG-іконки з assets/icons; кожен файл запитується один раз на весь застосунок. */
@Injectable({ providedIn: 'root' })
export class IconRegistry {
  private readonly http = inject(HttpClient);
  private readonly cache = new Map<string, Observable<string>>();

  get(name: string): Observable<string> {
    let svg = this.cache.get(name);
    if (!svg) {
      const path = `assets/icons/${name}.svg`;
      svg = this.http.get(path, { responseType: 'text' }).pipe(
        catchError((error) => {
          console.error(`Error loading icon: ${path}`, error);
          // Не кешуємо збій: наступна іконка з цією назвою спробує ще раз.
          this.cache.delete(name);
          return of('');
        }),
        shareReplay(1),
      );
      this.cache.set(name, svg);
    }
    return svg;
  }
}
