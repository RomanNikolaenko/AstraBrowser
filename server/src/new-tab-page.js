(token) => {
  // Посилання, відкрите коліщатком чи з Ctrl, — нова вкладка у фоні, як у Chrome (із Shift — одразу на неї). Чим сайт
  // відкриває нове вікно, WebView2 браузерові не каже, тож такі кліки відкриває сам браузер (pages.rs, open-tab). Клік,
  // який сайт уже обробив (preventDefault), не чіпаємо: слухач на window спрацьовує після всіх обробників сайту.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;

  const link = (event) =>
    event
      .composedPath()
      .find((node) => (node.localName === 'a' || node.localName === 'area') && typeof node.href === 'string' && node.href);

  const open = (event) => {
    const middle = event.type === 'auxclick' && event.button === 1;
    const control = event.type === 'click' && event.button === 0 && (event.ctrlKey || event.metaKey);
    if (!event.isTrusted || event.defaultPrevented || !(middle || control)) {
      return;
    }
    const target = link(event);
    const url = target && String(target.href);
    // Не вебові посилання (javascript:, mailto:…) — як і були.
    if (!url || !/^https?:/i.test(url)) {
      return;
    }
    event.preventDefault();
    post(toJson({ astra: 'open-tab', token, url, background: !event.shiftKey }));
  };
  window.addEventListener('auxclick', open);
  window.addEventListener('click', open);
}
