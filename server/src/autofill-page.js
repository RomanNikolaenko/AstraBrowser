(token) => {
  // Автозаповнення адрес (server/src/addresses.rs). Користувач став у поле адреси (ім'я, вулиця, місто, телефон…) —
  // браузер показує над сайтом збережені адреси. Список малює інтерфейс браузера, а не ця сторінка, тож скрипти сайту
  // адрес не бачать; вибрали одну — браузер передає значення лише для полів цієї форми, і скрипт заповнює ними її
  // частину з полем. Після надсилання форми з адресою — просить браузер запропонувати зберегти її.
  // З браузером говорить лише через chrome.webview і з токеном цієї сторінки. Усе потрібне береться одразу,
  // ще до скриптів сайту, тож підмінити це сайт уже не може.
  if (window.top !== window || !window.chrome || !window.chrome.webview) {
    return;
  }
  const webview = window.chrome.webview;
  const post = webview.postMessage.bind(webview);
  const onMessage = webview.addEventListener.bind(webview);
  // Рядком: повідомлення-об'єкт першим отримує обробник IPC Tauri, відкидає його, і до браузера воно не доходить.
  const toJson = JSON.stringify;
  const send = (message) => post(toJson({ astra: 'autofill', token, ...message }));
  const addListener = EventTarget.prototype.addEventListener;
  const listen = (target, type, handler) => addListener.call(target, type, handler, true);
  const later = window.setTimeout.bind(window);
  const nextFrame = window.requestAnimationFrame.bind(window);
  const setRepeat = window.setInterval.bind(window);
  const stopRepeat = window.clearInterval.bind(window);
  const descriptorOf = (type) => Object.getOwnPropertyDescriptor(type.prototype, 'value');
  const accessors = [
    [HTMLInputElement, descriptorOf(HTMLInputElement)],
    [HTMLTextAreaElement, descriptorOf(HTMLTextAreaElement)],
    [HTMLSelectElement, descriptorOf(HTMLSelectElement)],
  ];
  const accessorOf = (field) => accessors.find(([type]) => field instanceof type)[1];
  const valueOf = (field) => accessorOf(field).get.call(field);
  const setValue = (field, value) => accessorOf(field).set.call(field, value);
  const optionsOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'options').get;
  const selectedIndexOf = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  // Справжня ціль події — й у відкритому shadow DOM сайту.
  const targetOf = (event) => event.composedPath()[0];

  // Поля, які адреса заповнює: текстові, текстові області й випадні списки.
  const TEXT_TYPES = ['text', 'email', 'tel', 'number'];
  const isInput = (node) => node instanceof HTMLInputElement && TEXT_TYPES.includes(node.type);
  const isField = (node) => isInput(node) || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement;
  const visible = (node) =>
    node.isConnected &&
    !node.disabled &&
    !node.readOnly &&
    node.getClientRects().length > 0 &&
    getComputedStyle(node).visibility !== 'hidden';

  /** Поле, у якому фокус, — і всередині shadow DOM. */
  function activeField() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  // ——— Що це за поле ———

  /** Призначення з autocomplete (HTML): останнє слово — що в полі. */
  const TOKENS = {
    name: 'name',
    'given-name': 'given',
    'family-name': 'family',
    organization: 'organization',
    'street-address': 'street',
    'address-line1': 'line1',
    'address-line2': 'line2',
    'address-level2': 'city',
    'address-level1': 'region',
    'postal-code': 'postal',
    country: 'country',
    'country-name': 'country',
    tel: 'phone',
    'tel-national': 'phone',
    email: 'email',
  };
  // Поля з цим призначенням — не адреса: вхід, банківські картки, одноразові коди.
  const FOREIGN =
    /^(username|current-password|new-password|one-time-code|cc-|transaction-|bday|sex|url|photo|impp|webauthn|additional-name|honorific)/;

  /** Вид поля за autocomplete: рядок — вид, null — точно не адреса, undefined — не сказано. */
  function byAutocomplete(field) {
    const tokens = (field.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (Object.prototype.hasOwnProperty.call(TOKENS, last)) {
      return TOKENS[last];
    }
    return FOREIGN.test(last) ? null : undefined;
  }

  // Вид поля за його назвою, id, підказкою й підписом. Порядок важить: вужчі — раніше.
  const PATTERNS = [
    [null, /user ?name|login|логін|логин|captcha|coupon|promo|купон|промокод|search|пошук|поиск|card|картк|cvv|cvc|password|пароль/],
    ['email', /e ?mail|пошт|почт/],
    ['phone', /phone|\btel\b|mobile|телефон|мобільн|мобильн/],
    ['postal', /\bzip|postal|post ?code|індекс|индекс/],
    ['country', /country|країн|стран/],
    ['region', /region|\bstate\b|province|county|област|регіон|регион/],
    ['city', /city|town|locality|місто|міста|город|населен/],
    ['line2', /address ?(line)? ?2|\baddr ?2|apartment|\bapt\b|suite|\bflat\b|квартир|офіс|офис|під.?їзд|подъезд/],
    ['line1', /address ?(line)? ?1|\baddr ?1|street|вулиц|улиц/],
    ['street', /address|\baddr\b|адрес/],
    ['organization', /company|organi[sz]ation|компані|організац|организац/],
    ['name', /full ?name|піб|фіо|фио|ім.?я (та|і|й) прізвищ|прізвище,? ((та|і|й) )?ім.?я/],
    ['family', /last ?name|\blname|surname|family ?name|прізвищ|фамили/],
    ['given', /first ?name|\bfname|given ?name|ім.?я|імя|имя/],
    ['name', /\bname\b/],
  ];

  function describe(field) {
    const label = field.labels && field.labels[0] ? field.labels[0].textContent : '';
    const labelledBy = (field.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => (id && document.getElementById(id) ? document.getElementById(id).textContent : ''))
      .join(' ');
    return [label, labelledBy, field.getAttribute('aria-label'), field.name, field.id, field.getAttribute('placeholder')]
      .filter(Boolean)
      .join(' ')
      .slice(0, 300)
      .toLowerCase()
      .replace(/[_\-.[\]]+/g, ' ');
  }

  /** Вид поля (TOKENS) і чи задав його сам сайт (autocomplete); null — не адреса. */
  function kindOf(field) {
    if (!isField(field)) {
      return null;
    }
    const declared = byAutocomplete(field);
    if (declared !== undefined) {
      return declared && { kind: declared, declared: true };
    }
    if (field.type === 'email') {
      return { kind: 'email', declared: false };
    }
    if (field.type === 'tel') {
      return { kind: 'phone', declared: false };
    }
    const text = describe(field);
    const found = PATTERNS.find(([, pattern]) => pattern.test(text));
    return found && found[0] ? { kind: found[0], declared: false } : null;
  }

  /**
   * Частини форми: поля адреси в порядку на сторінці, а вид, що повторюється (доставка й оплата), починає нову
   * частину. Без форми (null) — уся сторінка.
   */
  function sectionsIn(form) {
    const scope = form ? [...form.elements] : [...document.querySelectorAll('input, textarea, select')];
    const sections = [];
    let section = null;
    let seen = new Set();
    for (const candidate of scope) {
      const found = visible(candidate) && kindOf(candidate);
      if (!found) {
        continue;
      }
      if (!section || seen.has(found.kind)) {
        section = [];
        sections.push(section);
        seen = new Set();
      }
      seen.add(found.kind);
      section.push({ field: candidate, ...found });
    }
    return sections;
  }

  const sectionWith = (field) => sectionsIn(field.form).find((section) => section.some((item) => item.field === field)) || [];

  /**
   * Вид поля, для якого варто показати адреси, — лише текстові поля в частині форми, схожій на адресу: вид задав сам
   * сайт або в ній щонайменше три різні поля адреси. Пошта у формі з паролем — це вхід, там свої підказки.
   */
  function suggestible(field) {
    if (!isInput(field) || !visible(field)) {
      return null;
    }
    const section = sectionWith(field);
    const item = section.find((entry) => entry.field === field);
    if (!item || (!item.declared && new Set(section.map((entry) => entry.kind)).size < 3)) {
      return null;
    }
    const scope = field.form || document;
    if (item.kind === 'email' && scope.querySelector('input[type=password]')) {
      return null;
    }
    return { kind: item.kind, kinds: [...new Set(section.map((entry) => entry.kind))] };
  }

  // ——— Список адрес над полем ———

  /** Поле, для якого показано (чи запитано) список. */
  let field = null;
  let seq = 0;
  let shown = false;
  /** Користувач ходив списком стрілками — тоді Enter вибирає адресу, а не надсилає форму. */
  let navigated = false;

  function rectOf(target) {
    const rect = target.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    return { x: rect.left * ratio, y: rect.top * ratio, width: rect.width * ratio, height: rect.height * ratio };
  }

  function open(target) {
    const found = suggestible(target);
    if (!found) {
      close();
      return;
    }
    field = target;
    shown = false;
    navigated = false;
    send({ type: 'focus', seq: ++seq, kind: found.kind, kinds: found.kinds, rect: rectOf(target) });
  }

  /** Сховати список, але пам'ятати поле: клік у нього чи порожнє поле покаже список знову. */
  function hide() {
    if (field) {
      seq++;
      shown = false;
      navigated = false;
      send({ type: 'hide' });
    }
  }

  function close() {
    hide();
    field = null;
  }

  let moving = false;
  /** Сторінка прокрутилась чи змінила розмір — список іде за полем. */
  function follow() {
    if (!shown || moving) {
      return;
    }
    moving = true;
    nextFrame(() => {
      moving = false;
      if (shown && field && field.isConnected) {
        send({ type: 'move', rect: rectOf(field) });
      }
    });
  }

  onMessage('message', (event) => {
    const data = event.data;
    if (!data || data.astra !== 'autofill') {
      return;
    }
    if (data.type === 'shown') {
      shown = !!data.on && !!field && data.seq === seq;
    } else if (data.type === 'fill' && data.values && typeof data.values === 'object') {
      fill(data.values);
    }
  });

  listen(document, 'focusin', (event) => {
    const target = targetOf(event);
    // Фокус повернувся в те саме поле (з інтерфейсу браузера чи іншої програми) — список сам не з'являється.
    if (!event.isTrusted || target === field) {
      return;
    }
    if (isField(target)) {
      open(target);
    } else {
      close();
    }
  });
  listen(document, 'pointerdown', (event) => {
    const target = targetOf(event);
    // Клік у поле, де вже стоїть курсор, — знову показати список.
    if (event.isTrusted && target === field && !shown && target === activeField()) {
      open(target);
    }
  });
  listen(document, 'focusout', (event) => {
    if (!field || targetOf(event) !== field) {
      return;
    }
    later(() => {
      if (!field) {
        return;
      }
      if (document.hasFocus()) {
        if (activeField() !== field) {
          close();
        }
      } else if (shown) {
        // Сторінка втратила фокус — клік у список (інтерфейс браузера) чи інша програма; що саме, знає інтерфейс.
        shown = false;
        navigated = false;
        send({ type: 'blur' });
      }
    }, 0);
  });
  listen(document, 'input', (event) => {
    if (!event.isTrusted || !field || targetOf(event) !== field) {
      return;
    }
    // Користувач пише сам — список не заважає; стер усе — список знову.
    if (valueOf(field) === '') {
      open(field);
    } else if (shown) {
      hide();
    }
  });
  listen(document, 'keydown', (event) => {
    if (!event.isTrusted || !field || targetOf(event) !== field || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (!shown) {
      if (event.key === 'ArrowDown') {
        open(field);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      navigated = true;
      send({ type: 'key', key: event.key });
    } else if (event.key === 'Enter' && navigated) {
      event.preventDefault();
      event.stopImmediatePropagation();
      send({ type: 'key', key: 'Enter' });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      hide();
    }
  });
  listen(document, 'scroll', follow);
  listen(window, 'resize', follow);
  listen(window, 'pagehide', close);

  // ——— Заповнення ———

  const normalize = (text) =>
    String(text)
      .toLowerCase()
      .replace(/[.,'’ʼ`"()-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  /** Назви країн (мовами сторінки, української, англійської й російської) — за кодом ISO; рахуються раз. */
  let countries = null;
  function countryNames(value) {
    if (!countries) {
      countries = [];
      const languages = [document.documentElement.lang, 'uk', 'en', 'ru'].filter(Boolean);
      const namers = languages.flatMap((language) => {
        try {
          return [new Intl.DisplayNames([language], { type: 'region', fallback: 'none' })];
        } catch {
          return [];
        }
      });
      for (let first = 65; first <= 90; first++) {
        for (let second = 65; second <= 90; second++) {
          const code = String.fromCharCode(first, second);
          const names = namers.map((namer) => namer.of(code)).filter(Boolean);
          if (names.length) {
            countries.push([code.toLowerCase(), ...names.map(normalize)]);
          }
        }
      }
    }
    const wanted = normalize(value);
    return countries.find((names) => names.includes(wanted)) || [wanted];
  }

  /** Пункт випадного списку для значення: та сама назва чи код, а для області чи міста — й частина назви. */
  function optionFor(select, value, kind) {
    const options = [...optionsOf.call(select)];
    const wanted = kind === 'country' ? countryNames(value) : [normalize(value)];
    const exact = options.find((option) => wanted.includes(normalize(option.value)) || wanted.includes(normalize(option.text)));
    if (exact || kind === 'country') {
      return exact || null;
    }
    return (
      options.find((option) => {
        const text = normalize(option.text);
        return text.length > 1 && wanted.some((name) => name && (text.includes(name) || name.includes(text)));
      }) || null
    );
  }

  /** Поле порожнє: нічого не введено, а в списку вибрано заглушку («Оберіть…»). */
  function isBlank(target) {
    if (target instanceof HTMLSelectElement) {
      const index = selectedIndexOf.get.call(target);
      return index < 0 || (index === 0 && !optionsOf.call(target)[0].value.trim());
    }
    return !valueOf(target).trim();
  }

  function put(target, kind, value) {
    if (target instanceof HTMLSelectElement) {
      const option = optionFor(target, value, kind);
      if (!option || option.selected) {
        return;
      }
      selectedIndexOf.set.call(target, option.index);
    } else {
      let text = kind === 'street' && !(target instanceof HTMLTextAreaElement) ? value.replace(/\s*\n\s*/g, ', ') : value;
      if (target.type === 'number') {
        text = text.replace(/\D/g, '');
      }
      if (target.maxLength > 0) {
        text = text.slice(0, target.maxLength);
      }
      setValue(target, text);
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Вибрана адреса: поле, з якого вибирали, — завжди, а решта полів його частини форми — якщо ще порожні. */
  function fill(values) {
    const anchor = field;
    if (!anchor || !anchor.isConnected) {
      return;
    }
    for (const { field: target, kind } of sectionWith(anchor)) {
      const value = values[kind];
      if (typeof value === 'string' && value && (target === anchor || isBlank(target))) {
        put(target, kind, value);
      }
    }
    shown = false;
    navigated = false;
  }

  // ——— Збереження адреси після надсилання форми ———

  /** Що ввели в поля адреси: частина форми, де заповнено найбільше. */
  function entered(target) {
    const form = target.form || (target.closest && target.closest('form')) || null;
    let best = null;
    for (const section of sectionsIn(form)) {
      const values = {};
      for (const { field: item, kind } of section) {
        const value =
          item instanceof HTMLSelectElement
            ? isBlank(item)
              ? ''
              : optionsOf.call(item)[selectedIndexOf.get.call(item)].text
            : valueOf(item);
        if (value.trim() && !values[kind]) {
          values[kind] = value.trim();
        }
      }
      if (!best || Object.keys(values).length > Object.keys(best.values).length) {
        best = { values, input: section[0].field };
      }
    }
    return best && Object.keys(best.values).length >= 3 ? best : null;
  }

  let pending = null;
  let sent = '';

  /** Надсилання форми. Вдалося — якщо сторінка пішла чи поля зникли; лишилися кілька секунд — найпевніше, помилка. */
  function attempt(target) {
    const found = entered(target);
    if (!found || (pending && toJson(pending.values) === toJson(found.values))) {
      return;
    }
    pending = found;
    let checks = 0;
    const timer = setRepeat(() => {
      if (pending !== found) {
        stopRepeat(timer);
      } else if (!visible(found.input)) {
        stopRepeat(timer);
        submitted();
      } else if (++checks >= 10) {
        stopRepeat(timer);
        pending = null;
      }
    }, 500);
  }

  function submitted() {
    if (!pending) {
      return;
    }
    const { values } = pending;
    pending = null;
    if (sent === toJson(values)) {
      return;
    }
    sent = toJson(values);
    send({ type: 'submitted', values });
  }

  listen(document, 'submit', (event) => event.isTrusted && attempt(targetOf(event)));
  listen(document, 'click', (event) => {
    const target = targetOf(event);
    const button =
      event.isTrusted && target.closest && target.closest('button, input[type=submit], input[type=button], [role=button]');
    if (button) {
      attempt(button);
    }
  });
  listen(document, 'keydown', (event) => {
    const target = targetOf(event);
    if (event.isTrusted && event.key === 'Enter' && !event.defaultPrevented && isInput(target)) {
      attempt(target);
    }
  });
  listen(window, 'pagehide', submitted);
}
