(token, interfaceLanguage) => {
  // Переклад виділеного тексту: праворуч над виділенням з'являється значок, а натиснули його — віконце з двома
  // мовами (оригінал — типово «визначити», переклад — типово мова інтерфейсу) і перекладом, який робить браузер
  // (server/src/translate.rs). Змінили мову — текст перекладається наново. Значок і віконце — у закритому shadow DOM:
  // стилі сайту їх не чіпають, а скрипти сайту не бачать. Розмітка — лише через createElement: рядки HTML на сайтах
  // із Trusted Types (YouTube, Gmail) заборонені.
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
  const CARD = 380;

  /** Мови Google Перекладача в списках (назви — мовою інтерфейсу). */
  const LANGUAGES = [
    'uk', 'en', 'de', 'fr', 'es', 'it', 'pl', 'pt', 'nl', 'sv', 'da', 'no', 'fi', 'cs', 'sk', 'hu', 'ro', 'bg', 'hr',
    'sr', 'sl', 'el', 'lt', 'lv', 'et', 'ka', 'tr', 'he', 'ar', 'hi', 'ja', 'ko', 'zh-CN', 'zh-TW',
  ];
  const AUTO = 'auto';

  /** Тексти віконця мовою інтерфейсу. */
  const TEXTS = {
    uk: {
      icon: 'Перекласти виділене',
      card: 'Переклад',
      source: 'Мова оригіналу',
      target: 'Мова перекладу',
      auto: 'Визначити мову',
      detected: '{0} (визначено)',
      loading: 'Перекладаємо…',
      same: 'Текст уже цією мовою — виберіть іншу мову перекладу.',
      copy: 'Копіювати',
      copied: 'Скопійовано',
      close: 'Закрити',
    },
    en: {
      icon: 'Translate selection',
      card: 'Translation',
      source: 'Source language',
      target: 'Translation language',
      auto: 'Detect language',
      detected: '{0} (detected)',
      loading: 'Translating…',
      same: 'The text is already in this language — choose another one.',
      copy: 'Copy',
      copied: 'Copied',
      close: 'Close',
    },
  };
  let language = interfaceLanguage === 'en' ? 'en' : 'uk';
  const say = (key) => TEXTS[language][key];

  /** Назви мов — мовою інтерфейсу, з великої літери; рахуються раз для кожної мови інтерфейсу. */
  const names = new Map();
  const languageName = (code) => {
    const key = `${language}:${code}`;
    if (!names.has(key)) {
      let name = code;
      try {
        name = new Intl.DisplayNames([language], { type: 'language' }).of(code) || code;
      } catch {
        // Невідомий код — показуємо як є.
      }
      names.set(key, name[0].toLocaleUpperCase(language) + name.slice(1));
    }
    return names.get(key);
  };

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
      font-size: 14px; line-height: 1.5; color: #1b2340; color-scheme: light; background: #fff;
      border: 1px solid #e3e8f5; border-radius: 14px; box-shadow: 0 12px 36px rgb(20 30 70 / 22%);
      animation: appear 120ms ease-out;
    }
    .head { display: flex; gap: 6px; align-items: center; margin-bottom: 10px; }
    .pick { position: relative; flex: 0 1 auto; min-width: 0; }
    .pick::after {
      position: absolute; top: 50%; right: 9px; width: 6px; height: 6px; pointer-events: none; content: '';
      border-right: 1.5px solid #6f7aa8; border-bottom: 1.5px solid #6f7aa8; transform: translateY(-70%) rotate(45deg);
    }
    select {
      max-width: 100%; padding: 5px 24px 5px 9px; overflow: hidden; font-size: 12px; font-weight: 600; color: #2638b7;
      text-overflow: ellipsis; white-space: nowrap; cursor: pointer; background: #f4f6ff; border: 1px solid #dce3ff;
      border-radius: 8px; outline: none; appearance: none;
    }
    select:hover { background: #eef2ff; }
    select:focus-visible { border-color: #4f5af7; box-shadow: 0 0 0 2px rgb(79 90 247 / 25%); }
    .measure { position: absolute; visibility: hidden; font-size: 12px; font-weight: 600; white-space: nowrap; }
    .arrow { flex: 0 0 auto; font-size: 13px; color: #8a93b5; }
    .close {
      display: grid; flex: 0 0 auto; place-items: center; width: 24px; height: 24px; padding: 0; margin-left: auto; font-size: 18px;
      line-height: 1; color: #6f7aa8; cursor: pointer; background: transparent; border: 0; border-radius: 6px;
    }
    .close:hover { background: #eef2ff; }
    .text {
      max-height: 240px; overflow: auto; font-size: 15px; white-space: pre-wrap; overflow-wrap: anywhere;
      user-select: text; outline: none;
    }
    .note { margin-top: 6px; font-size: 12px; color: #8a93b5; }
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
      .card { color: #e6ebff; color-scheme: dark; background: #141b33; border-color: #28324f; }
      .close, .arrow, .note { color: #8e98bf; }
      .pick::after { border-color: #8e98bf; }
      .close:hover, .copy:hover, select:hover { background: #1b2343; }
      select, .copy { color: #b4c3ff; background: #1c2552; border-color: #36438f; }
      .card[data-state='error'] .text { color: #ff8a80; }
    }
  `;

  let host = null;
  let icon = null;
  let card = null;
  let source = null;
  let target = null;
  let output = null;
  let note = null;
  let copy = null;
  let close = null;
  /** Невидимий рядок, яким міряється назва вибраної мови: список стає саме такої ширини. */
  let measure = null;
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

  const option = (value, text) => {
    const node = element('option', '', text);
    node.value = value;
    return node;
  };

  /** Список мов, за назвами мовою інтерфейсу; `auto` — ще й «Визначити мову» першим. */
  const fillLanguages = (select, withAuto) => {
    const chosen = select.value;
    const sorted = [...LANGUAGES].sort((a, b) => languageName(a).localeCompare(languageName(b), language));
    select.replaceChildren(
      ...(withAuto ? [option(AUTO, say('auto'))] : []),
      ...sorted.map((code) => option(code, languageName(code)))
    );
    if (chosen) {
      select.value = chosen;
    }
  };

  /** Підписи мовою інтерфейсу — він міг змінитися, поки сторінка відкрита. */
  const label = () => {
    icon.title = say('icon');
    icon.setAttribute('aria-label', say('icon'));
    card.setAttribute('aria-label', say('card'));
    source.setAttribute('aria-label', say('source'));
    source.title = say('source');
    target.setAttribute('aria-label', say('target'));
    target.title = say('target');
    close.title = say('close');
    close.setAttribute('aria-label', say('close'));
    fillLanguages(source, true);
    fillLanguages(target, false);
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
    icon.hidden = true;
    icon.append(translateIcon());
    // Натискання на значок не має знімати виділення.
    icon.addEventListener('mousedown', (event) => event.preventDefault());
    icon.addEventListener('click', open);

    card = element('div', 'card');
    card.setAttribute('role', 'dialog');
    card.hidden = true;
    const head = element('div', 'head');
    const sourcePick = element('label', 'pick');
    source = element('select');
    sourcePick.append(source);
    const targetPick = element('label', 'pick');
    target = element('select');
    targetPick.append(target);
    const arrow = element('span', 'arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    close = element('button', 'close', '×');
    close.type = 'button';
    close.addEventListener('click', hide);
    head.append(sourcePick, arrow, targetPick, close);
    // Інша мова — той самий текст перекладається наново.
    source.addEventListener('change', translate);
    target.addEventListener('change', translate);
    measure = element('span', 'measure');
    measure.setAttribute('aria-hidden', 'true');
    head.append(measure);
    output = element('div', 'text');
    output.tabIndex = 0;
    note = element('div', 'note');
    note.hidden = true;
    const foot = element('div', 'foot');
    copy = element('button', 'copy');
    copy.type = 'button';
    copy.addEventListener('click', copyTranslation);
    foot.append(copy);
    card.append(head, output, note, foot);

    label();
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

  /** Список — завширшки з назву вибраної мови (і стрілку); тісно — назва скорочується «…». */
  const fit = (select) => {
    measure.textContent = select.selectedOptions[0] ? select.selectedOptions[0].textContent : '';
    select.style.width = `${Math.ceil(measure.offsetWidth) + 46}px`;
  };

  const show = (state, text, hint) => {
    card.dataset.state = state;
    output.textContent = text;
    note.textContent = hint || '';
    note.hidden = !hint;
    card.hidden = false;
    fit(source);
    fit(target);
    placeCard();
  };

  /** Віконце щойно відкрили: оригінал — визначити, переклад — мовою інтерфейсу. */
  function open() {
    icon.hidden = true;
    label();
    source.value = AUTO;
    target.value = language;
    translate();
  }

  function translate() {
    const id = ++request;
    translation = '';
    copy.textContent = say('copy');
    source.options[0].textContent = say('auto');
    show('loading', say('loading'));
    post(toJson({ astra: 'translate', token, id, text: selected.slice(0, MAX_TEXT), source: source.value, target: target.value }));
  }

  // Відповідь браузера — без токена (її бачать і скрипти сайту), тож лише номер запиту.
  webview.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.astra !== 'translate' || data.id !== request || !card || card.hidden) {
      return;
    }
    if (data.ui && data.ui !== language && TEXTS[data.ui]) {
      language = data.ui;
      label();
      copy.textContent = say('copy');
    }
    if (data.error) {
      show('error', data.error);
      return;
    }
    translation = data.text || '';
    // Визначену мову видно в першому списку: «Англійська (визначено)».
    if (source.value === AUTO && data.source) {
      source.options[0].textContent = say('detected').replace('{0}', languageName(data.source));
    }
    const same = data.source && data.target && data.source === data.target.split('-')[0];
    show('done', translation, same ? say('same') : '');
  });

  function copyTranslation() {
    const done = () => {
      copy.textContent = say('copied');
      later(() => (copy.textContent = say('copy')), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(translation).then(done, () => undefined);
    }
  }

  // Виділили мишею чи клавіатурою — значок; натиснули деінде, прокрутили сторінку, Esc — усе ховається.
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
      if (inside(event)) {
        return;
      }
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
  // Прокрутка самого перекладу (довгий текст) віконце не ховає — лише прокрутка сторінки.
  window.addEventListener(
    'scroll',
    (event) => {
      if (!inside(event)) {
        hide();
      }
    },
    { capture: true, passive: true }
  );
  window.addEventListener('resize', hide);
}
