import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { WindowControls } from '../window-controls/window-controls';
import { TitlebarSlot } from './titlebar-content';

/** Єдиний заголовок вікна для всіх екранів; екран може додати в нього свій вміст через `appTitlebarContent`. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, WindowControls],
  selector: 'app-titlebar',
  styleUrl: './titlebar.scss',
  templateUrl: './titlebar.html',
})
export class Titlebar {
  protected readonly slot = inject(TitlebarSlot);
}
