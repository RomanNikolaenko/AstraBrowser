(() => {
  // Контекстне меню сайту у WebKitGTK (gtk_page::customize_context_menu): що виділено, WebKit браузерові не каже, тож
  // перед меню виділений текст надсилається сюди — повідомлення встигає раніше за саме меню. Пароль не надсилається.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;
  // Пунктам меню (пошук, переклад) більшого не треба, а «виділити все» на великій сторінці — мегабайти щоразу.
  const MAX_TEXT = 5000;
  const selected = () => {
    const field = document.activeElement;
    if (field && (field.localName === 'input' || field.localName === 'textarea')) {
      if (field.type === 'password' || typeof field.selectionStart !== 'number') {
        return '';
      }
      return String(field.value).slice(field.selectionStart, field.selectionEnd).slice(0, MAX_TEXT);
    }
    return String(window.getSelection() || '').slice(0, MAX_TEXT);
  };
  window.addEventListener('contextmenu', () => post(toJson({ astra: 'context', selection: selected() })), true);
})();
