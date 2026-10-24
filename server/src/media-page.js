(token) => {
  // Відео чи аудіо на сторінці грає зі звуком: не на паузі, і звук не вимкнено ні в плеєрі, ні гучністю. Таку вкладку
  // браузер не присипляє, хоч би як довго на відео було тихо (тоді WebView2 вважає, що звуку немає). Лише головна
  // сторінка: у вбудованих фреймах інших сайтів chrome.webview немає — для них лишається відлік від звуку.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;
  const every = window.setInterval.bind(window);
  const stop = window.clearInterval.bind(window);
  const some = Array.prototype.some;
  // Скільки чекати між перевірками, поки грає: прибраний зі сторінки плеєр стає на паузу, але цієї події вже не видно.
  const RECHECK = 60_000;
  let playing = false;
  let timer = 0;

  const audible = (media) => !media.paused && !media.ended && !media.muted && media.volume > 0;
  const update = () => {
    const now = some.call(document.querySelectorAll('video, audio'), audible);
    if (now === playing) {
      return;
    }
    playing = now;
    post(toJson({ astra: 'media', token, playing }));
    if (playing) {
      timer = every(update, RECHECK);
    } else {
      stop(timer);
    }
  };
  // Події відео не спливають, але проходять через документ на фазі перехоплення.
  for (const type of ['play', 'playing', 'pause', 'ended', 'volumechange', 'emptied']) {
    document.addEventListener(type, update, true);
  }
}
