import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ConfirmDialog } from './confirm-dialog';

@Component({
  imports: [ConfirmDialog],
  template: `
    <button type="button" class="ask" (click)="dialog.show()">Очистити</button>
    <app-confirm-dialog
      #dialog
      heading="Очистити всю історію?"
      message="Цю дію не можна скасувати."
      confirmLabel="Очистити"
      danger
      (confirmed)="confirmed = confirmed + 1" />
  `,
})
class Host {
  confirmed = 0;
}

describe('ConfirmDialog', () => {
  const setup = async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const dialog = element.querySelector('dialog') as HTMLDialogElement;
    const component = fixture.debugElement.children[1].componentInstance as ConfirmDialog;
    const click = async (target: Element | null) => {
      (target as HTMLElement | null)?.click();
      await fixture.whenStable();
    };
    return { fixture, element, dialog, component, click };
  };

  it('should be a labelled modal with the safe action first', async () => {
    const { element, dialog } = await setup();

    expect(dialog.getAttribute('aria-labelledby')).toBe(element.querySelector('.confirm-dialog__title')?.id);
    expect(dialog.getAttribute('aria-describedby')).toBe(element.querySelector('.confirm-dialog__message')?.id);
    expect(dialog.classList).toContain('confirm-dialog--danger');
    const buttons = [...element.querySelectorAll('.confirm-dialog__button')].map((button) => button.textContent?.trim());
    expect(buttons).toEqual(['Скасувати', 'Очистити']);
    expect(element.querySelector('.confirm-dialog__button')?.hasAttribute('autofocus')).toBe(true);
  });

  it('should confirm only from its button and close either way', async () => {
    const { fixture, element, dialog, component, click } = await setup();

    await click(element.querySelector('.ask'));
    expect(component.isOpen()).toBe(true);

    await click(element.querySelector('.confirm-dialog__button'));
    expect(component.isOpen()).toBe(false);
    expect(fixture.componentInstance.confirmed).toBe(0);

    // Клік повз вікно й Esc закривають його самим браузером.
    expect(dialog.getAttribute('closedby')).toBe('any');
    dialog.dispatchEvent(new Event('close'));
    await fixture.whenStable();
    expect(component.isOpen()).toBe(false);

    await click(element.querySelector('.ask'));
    await click(element.querySelector('.confirm-dialog__button--confirm'));
    expect(component.isOpen()).toBe(false);
    expect(fixture.componentInstance.confirmed).toBe(1);
  });
});
