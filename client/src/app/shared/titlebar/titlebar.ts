import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BrowserWindows } from '../browser-windows/browser-windows';
import { MiddleClick } from '../middle-click/middle-click';
import { UiIcon } from '../ui-icon/ui-icon';
import { WindowControls } from '../window-controls/window-controls';
import { TitlebarSlot } from './titlebar-content';
import { TranslatePipe } from '../i18n/i18n';

/** Єдиний заголовок вікна для всіх екранів; екран може додати в нього свій вміст через `appTitlebarContent`. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, MiddleClick, NgTemplateOutlet, UiIcon, WindowControls],
  selector: 'app-titlebar',
  styleUrl: './titlebar.scss',
  templateUrl: './titlebar.html',
})
export class Titlebar {
  protected readonly slot = inject(TitlebarSlot);
  protected readonly isPrivate = inject(BrowserWindows).isPrivate;
  protected readonly isGuest = inject(BrowserWindows).isGuest;
}
