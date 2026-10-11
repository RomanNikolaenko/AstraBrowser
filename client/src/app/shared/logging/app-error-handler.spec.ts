import { AppErrorHandler, describeError } from './app-error-handler';

describe('AppErrorHandler', () => {
  it('should describe any error as text for the log', () => {
    const error = new TypeError('tabs is undefined');
    expect(describeError(error)).toContain('TypeError: tabs is undefined');
    expect(describeError('Немає зв’язку')).toBe('Немає зв’язку');
    expect(describeError({ code: 'offline' })).toBe('{"code":"offline"}');

    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(describeError(circular)).toBe('[object Object]');
  });

  it('should still show the error in the console', () => {
    const console = vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const error = new Error('boom');

    new AppErrorHandler().handleError(error);

    expect(console).toHaveBeenCalledWith(error);
    console.mockRestore();
  });
});
