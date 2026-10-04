(token) => {
  // Ctrl + коліщатко на сайті — масштаб браузера, як у Chrome (сам WebView2 масштабу не змінює: його керує
  // інтерфейс, щоб плашка масштабу й «−»/«+» знали, який він). Якщо сайт забрав жест собі (мапи, редактори
  // викликають preventDefault), масштаб не чіпаємо. Тачпад дає дрібні прокрутки — вони накопичуються до кроку.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;
  const later = window.setTimeout.bind(window);
  const now = performance.now.bind(performance);
  // Скільки прокрутки — один крок масштабу (клацання коліщатка — близько 100), і через скільки мс накопичене забувається.
  const STEP = 50;
  const IDLE = 400;
  let sum = 0;
  let last = 0;

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.isTrusted || !event.ctrlKey || !event.deltaY) {
        return;
      }
      // Чи сайт обробив жест сам, видно лише після всіх його обробників.
      later(() => {
        if (event.defaultPrevented) {
          return;
        }
        const time = now();
        sum = time - last > IDLE ? event.deltaY : sum + event.deltaY;
        last = time;
        if (Math.abs(sum) >= STEP) {
          post(toJson({ astra: 'zoom', token, step: sum < 0 ? 'in' : 'out' }));
          sum = 0;
        }
      });
    },
    { capture: true, passive: true }
  );
}
