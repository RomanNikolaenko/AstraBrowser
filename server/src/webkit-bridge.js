(() => {
  // Канал скриптів браузера на сторінці сайту у WebKitGTK (Linux, gtk_page.rs) — у вигляді chrome.webview WebView2,
  // тож скрипти паролів, адрес, масштабу й перекладу ті самі, що й у Windows. Ці скрипти живуть в окремому світі
  // WebKit: DOM спільний, а змінні й прототипи — свої, тож сайт не бачить ні каналу, ні відповідей браузера.
  const handlers = window.webkit && window.webkit.messageHandlers;
  if (window.top !== window || !handlers || !handlers.astra) {
    return;
  }
  const handler = handlers.astra;
  const post = handler.postMessage.bind(handler);
  const listeners = [];
  window.chrome = {
    webview: {
      postMessage: (message) => post(message),
      addEventListener: (type, listener) => {
        if (type === 'message') {
          listeners.push(listener);
        }
      },
    },
  };
  // Повідомлення браузера (gtk_page::post_page_message) — слухачам, як подія message WebView2.
  window.astraHostMessage = (data) => {
    for (const listener of listeners) {
      listener({ data });
    }
  };
})();
