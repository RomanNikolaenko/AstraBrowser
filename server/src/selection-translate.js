(token) => {
  // Переклад виділеного тексту: праворуч над виділенням з'являється значок, а натиснули його — віконце з перекладом,
  // який робить браузер (server/src/translate.rs). Значок і віконце — у закритому shadow DOM: стилі сайту їх не
  // чіпають, а скрипти сайту не бачать. Розмітка — лише через createElement: рядки HTML на сайтах із Trusted Types
  // (YouTube, Gmail) заборонені.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const toJson = JSON.stringify;
  const later = window.setTimeout.bind(window);

  // Найдовший текст, який надсилаємо (довший обрізаємо), розміри значка й віконця.
  const MAX_TEXT = 5000;
  const ICON = 30;
  const GAP = 6;
  const CARD = 340;

  let languages = null;
  try {
    languages = new Intl.DisplayNames(['uk'], { type: 'language' });
  } catch {
    languages = null;
  }
  const languageName = (code) => {
    if (!code) {
      return '';
    }
    try {
      return (languages && languages.of(code)) || code;
    } catch {
      return code;
    }
  };
  const capitalize = (text) => (text ? text[0].toLocaleUpperCase('uk') + text.slice(1) : text);

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: 'Segoe UI', system-ui, sans-serif; }
    [hidden] { display: none !important; }
    .icon {
      position: fixed; display: grid; place-items: center; width: ${ICON}px; height: ${ICON}px; padding: 0;
      color: #fff; cursor: pointer; background-color: #4f5af7;
      background-image: linear-gradient(135deg, #2f7bff 0%, #5b48f7 62%, #b876ff 100%);
      border: 0; border-radius: 50%; box-shadow: 0 4px 14px rgb(40 50 120 / 35%);
      animation: appear 120ms ease-out;
    }
    .icon:hover { filter: brightness(1.08); }
    .icon:focus-visible { outline: 2px solid #9fb0ff; outline-offset: 2px; }
    .icon svg { width: 18px; height: 18px; }
    .card {
      position: fixed; width: ${CARD}px; max-width: calc(100vw - ${GAP * 2}px); padding: 12px 14px;
      font-size: 14px; line-height: 1.5; color: #1b2340; background: #fff;
      border: 1px solid #e3e8f5; border-radius: 14px; box-shadow: 0 12px 36px rgb(20 30 70 / 22%);
      animation: appear 120ms ease-out;
    }
    .head { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .title { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; color: #6f7aa8; }
    .close {
      display: grid; place-items: center; width: 24px; height: 24px; padding: 0; font-size: 18px; line-height: 1;
      color: #6f7aa8; cursor: pointer; background: transparent; border: 0; border-radius: 6px;
    }
    .close:hover { background: #eef2ff; }
    .text {
      max-height: 240px; overflow: auto; font-size: 15px; white-space: pre-wrap; overflow-wrap: anywhere;
      user-select: text; outline: none;
    }
    .card[data-state='loading'] .text { color: #8a93b5; }
    .card[data-state='error'] .text { color: #b9280f; }
    .foot { display: flex; justify-content: flex-end; margin-top: 10px; }
    .card[data-state='loading'] .foot, .card[data-state='error'] .foot { display: none; }
    .copy {
      padding: 6px 12px; font-size: 13px; font-weight: 600; color: #2638b7; cursor: pointer;
      background: #f4f6ff; border: 1px solid #dce3ff; border-radius: 8px;
    }
    .copy:hover { background: #eef2ff; }
    @keyframes appear { from { opacity: 0; transform: scale(0.92); } }
    @media (prefers-color-scheme: dark) {
      .card { color: #e6ebff; background: #141b33; border-color: #28324f; }
      .title, .close { color: #8e98bf; }
      .close:hover, .copy:hover { background: #1b2343; }
      .copy { color: #b4c3ff; background: #1c2552; border-color: #36438f; }
      .card[data-state='error'] .text { color: #ff8a80; }
    }
  `;

  let host = null;
  let icon = null;
  let card = null;
  let title = null;
  let output = null;
  let copy = null;
  /** Виділений текст і де він на екрані — для значка й віконця. */
  let selected = '';
  let bounds = null;
  /** Номер останнього запиту перекладу: відповіді на попередні ігноруються. */
  let request = 0;
  let translation = '';

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  };

  const translateIcon = () => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M4 5.5h8M8 3.5v2M10.5 5.5c-.8 3.6-3 6.3-6.5 8M6 9.5c1.1 1.6 2.6 2.9 4.5 3.8', 'M12.5 20.5l4-9.5 4 9.5M14 17h5']) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  };

  const build = () => {
    if (host) {
      if (!host.isConnected) {
        document.documentElement.append(host);
      }
      return;
    }
    host = document.createElement('astra-translate');
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(STYLE);
    root.adoptedStyleSheets = [sheet];

    icon = element('button', 'icon');
    icon.type = 'button';
    icon.title = 'Перекласти виділене';
    icon.setAttribute('aria-label', 'Перекласти виділене');
    icon.hidden = true;
    icon.append(translateIcon());
    // Натискання на значок не має знімати виділення.
    icon.addEventListener('mousedown', (event) => event.preventDefault());
    icon.addEventListener('click', open);

    card = element('div', 'card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Переклад');
    card.hidden = true;
    const head = element('div', 'head');
    title = element('span', 'title');
    const close = element('button', 'close', '×');
    close.type = 'button';
    close.title = 'Закрити';
    close.setAttribute('aria-label', 'Закрити');
    close.addEventListener('click', hide);
    head.append(title, close);
    output = element('div', 'text');
    output.tabIndex = 0;
    const foot = element('div', 'foot');
    copy = element('button', 'copy', 'Копіювати');
    copy.type = 'button';
    copy.addEventListener('click', copyTranslation);
    foot.append(copy);
    card.append(head, output, foot);

    root.append(icon, card);
    document.documentElement.append(host);
  };

  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));
  const inside = (event) => !!host && event.composedPath().includes(host);

  /** Виділений текст поза полями вводу і його межі; немає — null. */
  const selection = () => {
    const current = document.getSelection();
    if (!current || current.isCollapsed || !current.rangeCount) {
      return null;
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return null;
    }
    const text = current.toString().trim();
    const rect = current.getRangeAt(0).getBoundingClientRect();
    return text && (rect.width || rect.height) ? { text, rect } : null;
  };

  /** Значок — праворуч над виділенням (немає місця вгорі — під ним). */
  const showIcon = () => {
    const current = selection();
    if (!current) {
      if (!card || card.hidden) {
        hide();
      }
      return;
    }
    build();
    selected = current.text;
    bounds = current.rect;
    card.hidden = true;
    const above = bounds.top - ICON - GAP;
    icon.style.top = `${above >= GAP ? above : bounds.bottom + GAP}px`;
    icon.style.left = `${clamp(bounds.right - ICON, GAP, window.innerWidth - ICON - GAP)}px`;
    icon.hidden = false;
  };

  function hide() {
    request++;
    if (icon) {
      icon.hidden = true;
    }
    if (card) {
      card.hidden = true;
    }
  }

  /** Віконце — під виділенням, а якщо внизу тісно — над ним. */
  const placeCard = () => {
    const width = Math.min(CARD, window.innerWidth - GAP * 2);
    card.style.left = `${clamp(bounds.right - width, GAP, window.innerWidth - width - GAP)}px`;
    const height = card.offsetHeight;
    const below = bounds.bottom + GAP;
    const top = below + height <= window.innerHeight - GAP ? below : bounds.top - GAP - height;
    card.style.top = `${clamp(top, GAP, window.innerHeight - height - GAP)}px`;
  };

  const show = (state, heading, text) => {
    card.dataset.state = state;
    title.textContent = heading;
    output.textContent = text;
    card.hidden = false;
    placeCard();
  };

  function open() {
    const id = ++request;
    icon.hidden = true;
    translation = '';
    copy.textContent = 'Копіювати';
    show('loading', 'Переклад', 'Перекладаємо…');
    post(toJson({ astra: 'translate', token, id, text: selected.slice(0, MAX_TEXT) }));
  }

  // Відповідь браузера — без токена (її бачать і скрипти сайту), тож лише номер запиту.
  webview.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.astra !== 'translate' || data.id !== request || !card || card.hidden) {
      return;
    }
    if (data.error) {
      show('error', 'Переклад', data.error);
      return;
    }
    translation = data.text || '';
    const source = languageName(data.source);
    const target = languageName(data.target);
    const same = data.source && data.target && data.source === data.target.split('-')[0];
    const heading = same ? `${capitalize(target)} — текст уже цією мовою` : source ? `${capitalize(source)} → ${target}` : capitalize(target);
    show('done', heading, translation);
  });

  function copyTranslation() {
    const done = () => {
      copy.textContent = 'Скопійовано';
      later(() => (copy.textContent = 'Копіювати'), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(translation).then(done, () => undefined);
    }
  }

  // Виділили мишею чи клавіатурою — значок; натиснули деінде, прокрутили, Esc — усе ховається.
  document.addEventListener(
    'mouseup',
    (event) => {
      if (event.button === 0 && !inside(event)) {
        later(showIcon);
      }
    },
    true
  );
  document.addEventListener(
    'keyup',
    (event) => {
      if (event.key === 'Shift' || (event.shiftKey && event.key.startsWith('Arrow')) || ((event.ctrlKey || event.metaKey) && event.code === 'KeyA')) {
        later(showIcon);
      }
    },
    true
  );
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!inside(event)) {
        hide();
      }
    },
    true
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && host && (!icon.hidden || !card.hidden)) {
        hide();
      }
    },
    true
  );
  document.addEventListener('selectionchange', () => {
    if (icon && !icon.hidden && !selection()) {
      icon.hidden = true;
    }
  });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
  window.addEventListener('resize', hide);
}
