/**
 * Браузер працює в Linux (WebKitGTK): дещо там влаштовано інакше — інтерфейс над сайтом обрізаний формою, а не
 * прозорий (server/src/gtk_layers.rs), особу перед карткою підтверджує polkit, а не Windows Hello.
 */
export const IS_LINUX =
  typeof navigator !== 'undefined' && /\bLinux\b/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);
