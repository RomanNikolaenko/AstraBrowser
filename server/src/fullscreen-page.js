(token) => {
  // Повний екран сторінки — під затемненням браузера (fullscreen.rs), як у Firefox. Вихід (кнопка плеєра, F на
  // YouTube) чекає, доки екран потемніє, а вікно й сайт повернуться на місце. Після кожного переходу браузер чекає,
  // доки сторінка перемалюється (fullscreen-painted), і лише тоді знімає затемнення — її перебудови (YouTube — до
  // секунди) не видно.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;
  const later = window.setTimeout.bind(window);
  const frame = window.requestAnimationFrame.bind(window);
  const now = performance.now.bind(performance);
  // Скільки найдовше чекати браузер — щоб вихід не завис, хоч би що.
  const WAIT = 1500;
  let ready = null;

  // Сторінка перемалювалась: два кадри поспіль бувають, лише коли її скрипти скінчили перебудову. Розмір — фізичні
  // пікселі, як у вікна сайту.
  let lastChange = -Infinity;
  let pending = 0;
  const report = () => {
    const ticket = ++pending;
    frame(() =>
      frame(() => {
        if (ticket === pending) {
          post(
            toJson({
              astra: 'fullscreen-painted',
              token,
              fullscreen: !!document.fullscreenElement,
              width: Math.round(window.innerWidth * window.devicePixelRatio),
              height: Math.round(window.innerHeight * window.devicePixelRatio),
            })
          );
        }
      })
    );
  };
  document.addEventListener(
    'fullscreenchange',
    () => {
      lastChange = now();
      report();
    },
    true
  );
  // Зміни розміру — лише довкола переходу: звичайні браузерові не потрібні.
  window.addEventListener('resize', () => {
    if (document.fullscreenElement || now() - lastChange < 3000) {
      report();
    }
  });

  webview.addEventListener('message', (event) => {
    if (event.data && event.data.astra === 'fullscreen-ready' && ready) {
      const done = ready;
      ready = null;
      done();
    }
  });

  // Вихід — щойно браузер відповів: розмір сайту він уже змінив, тож сторінка отримає його разом із виходом і
  // збереться один раз.
  const prepare = () =>
    new Promise((resolve) => {
      ready = resolve;
      post(toJson({ astra: 'fullscreen-exit', token }));
      later(() => {
        if (ready === resolve) {
          ready = null;
          resolve();
        }
      }, WAIT);
    });

  for (const name of ['exitFullscreen', 'webkitExitFullscreen']) {
    const original = Document.prototype[name];
    if (typeof original !== 'function') {
      continue;
    }
    Object.defineProperty(Document.prototype, name, {
      configurable: true,
      writable: true,
      value: function (...args) {
        if (!document.fullscreenElement && !document.webkitFullscreenElement) {
          return original.apply(this, args);
        }
        return prepare().then(() => original.apply(this, args));
      },
    });
  }
}
