(token) => {
  // Автозаповнення адрес (server/src/addresses.rs) і банківських карток (server/src/cards.rs). Користувач став у поле
  // адреси (ім'я, вулиця, місто, телефон…) чи картки (номер, ім'я власника, термін дії) — браузер показує над сайтом
  // збережені адреси чи картки. Список малює інтерфейс браузера, а не ця сторінка, тож скрипти сайту їх не бачать;
  // вибрали одну — браузер передає значення лише для полів цієї форми, і скрипт заповнює ними її частину з полем.
  // CVV/CVC не заповнюється й не читається ніколи. Після надсилання форми з адресою чи карткою — просить браузер
  // запропонувати зберегти її.
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
    'cc-number': 'cc-number',
    'cc-name': 'cc-name',
    'cc-exp': 'cc-exp',
    'cc-exp-month': 'cc-exp-month',
    'cc-exp-year': 'cc-exp-year',
    'cc-csc': 'cc-csc',
  };
  // Поля з цим призначенням — ні адреса, ні картка: вхід, одноразові коди, частини імені власника картки тощо.
  const FOREIGN =
    /^(username|current-password|new-password|one-time-code|cc-|transaction-|bday|sex|url|photo|impp|webauthn|additional-name|honorific)/;

  /** Вид поля за autocomplete: рядок — вид, null — точно не адреса й не картка, undefined — не сказано. */
  function byAutocomplete(field) {
    const tokens = (field.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (Object.prototype.hasOwnProperty.call(TOKENS, last)) {
      return TOKENS[last];
    }
    return FOREIGN.test(last) ? null : undefined;
  }

  // Поля картки — за назвою, id, підказкою й підписом, ще до типу поля: номер картки часто має type="tel".
  const CARD_PATTERNS = [
    ['cc-csc', /cvv|cvc|csc|cvn|security ?code|код безпеки|секретний код/],
    [
      'cc-number',
      /card ?(number|no\b|num)|cardnumber|ccnumber|\bcc ?num|\bpan\b|номер (банківської )?(картки|карти|карты)|(\d{4}|x{4}|•{4}|\*{4})([ -](\d{4}|x{4}|•{4}|\*{4})){2}/,
    ],
    [
      'cc-name',
      /card ?holder|holder ?name|name ?on ?(the )?card|власник картки|ім.?я (власника|на картці)|владелец карты|имя (владельца|на карте)/,
    ],
    // «exp mm» без «/yy» далі — лише місяць; «MM/YY» — увесь термін (cc-exp нижче).
    ['cc-exp-month', /exp\w* ?(date )?mon|\bcc ?month|card ?month|exp ?mm\b(?! ?\/)/],
    ['cc-exp-year', /exp\w* ?(date )?y(ea)?r|\bcc ?year|card ?year|exp ?yy/],
    ['cc-exp', /expir|exp ?date|\bexp\b|valid ?(thru|through|until)|mm ?\/ ?yy|мм ?\/ ?(рр|гг)|термін дії|срок действия|дійсна до/],
  ];

  // Вид поля адреси за тим самим. Порядок важить: вужчі — раніше.
  const PATTERNS = [
    [null, /user ?name|login|логін|логин|captcha|coupon|promo|купон|промокод|search|пошук|поиск|card|картк|password|пароль/],
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

  const isCardKind = (kind) => kind.startsWith('cc-');

  /** Вид поля (TOKENS) і чи задав його сам сайт (autocomplete); null — ні адреса, ні картка. */
  function kindOf(field) {
    if (!isField(field)) {
      return null;
    }
    const declared = byAutocomplete(field);
    if (declared !== undefined) {
      return declared && { kind: declared, declared: true };
    }
    const description = describe(field);
    const card = CARD_PATTERNS.find(([, pattern]) => pattern.test(description));
    if (card) {
      return { kind: card[0], declared: false };
    }
    if (field.type === 'email') {
      return { kind: 'email', declared: false };
    }
    if (field.type === 'tel') {
      return { kind: 'phone', declared: false };
    }
    const found = PATTERNS.find(([, pattern]) => pattern.test(description));
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
   * Поле, для якого варто показати адреси чи картки, — лише текстові поля. Картки — у формі з номером картки (CVV/CVC —
   * ніколи); адреси — у частині форми, схожій на адресу: вид задав сам сайт або в ній щонайменше три різні поля адреси.
   * Пошта у формі з паролем — це вхід, там свої підказки. `kinds` — види полів того самого роду в цій частині форми.
   */
  function suggestible(field) {
    if (!isInput(field) || !visible(field)) {
      return null;
    }
    const section = sectionWith(field);
    const item = section.find((entry) => entry.field === field);
    if (!item) {
      return null;
    }
    const card = isCardKind(item.kind);
    const kinds = [...new Set(section.map((entry) => entry.kind))].filter((kind) => isCardKind(kind) === card);
    if (card) {
      return item.kind !== 'cc-csc' && kinds.includes('cc-number') ? { form: 'card', kind: item.kind, kinds } : null;
    }
    if (!item.declared && kinds.length < 3) {
      return null;
    }
    const scope = field.form || document;
    if (item.kind === 'email' && scope.querySelector('input[type=password]')) {
      return null;
    }
    return { form: 'address', kind: item.kind, kinds };
  }

  // ——— Список адрес чи карток над полем ———

  /** Поле, для якого показано (чи запитано) список. */
  let field = null;
  let seq = 0;
  let shown = false;
  /** Користувач ходив списком стрілками — тоді Enter вибирає адресу чи картку, а не надсилає форму. */
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
    send({ type: 'focus', form: found.form, seq: ++seq, kind: found.kind, kinds: found.kinds, rect: rectOf(target) });
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

  /** Число в тексті пункту чи поля: «07 — липень» — 7, «2028» — 2028; без числа — NaN. */
  const numberIn = (text) => Number((String(text).match(/\d+/) || [''])[0] || NaN);

  /** Пункт списку місяця чи року терміну дії: те саме число (рік — і двома цифрами). */
  function optionByNumber(select, value, kind) {
    const wanted = Number(value);
    const short = kind === 'cc-exp-year' ? wanted % 100 : wanted;
    return (
      [...optionsOf.call(select)].find((option) =>
        [option.value, option.text].some((text) => numberIn(text) === wanted || numberIn(text) === short)
      ) || null
    );
  }

  /**
   * Термін дії картки так, як просить поле: MM/YY, MM/YYYY (підказка з YYYY), MMYY (поле на 4 символи) чи MM / YY (з
   * пробілами, як у підказці). `value` — MM/YYYY від браузера; для окремого поля року — YY чи YYYY.
   */
  function expiryText(target, kind, value) {
    const hint = (target.getAttribute('placeholder') || '').toLowerCase();
    const long = /yyyy|рррр|гггг/.test(hint);
    if (kind === 'cc-exp-year') {
      return long || (target.maxLength !== 2 && !/^(yy|рр|гг)$/.test(hint.trim())) ? value : value.slice(-2);
    }
    const [month, year] = value.split('/');
    if (long) {
      return `${month}/${year}`;
    }
    if (target.maxLength === 4) {
      return `${month}${year.slice(-2)}`;
    }
    return /\s\/\s/.test(hint) ? `${month} / ${year.slice(-2)}` : `${month}/${year.slice(-2)}`;
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
      const option =
        kind === 'cc-exp-month' || kind === 'cc-exp-year' ? optionByNumber(target, value, kind) : optionFor(target, value, kind);
      if (!option || option.selected) {
        return;
      }
      selectedIndexOf.set.call(target, option.index);
    } else {
      let text = kind === 'street' && !(target instanceof HTMLTextAreaElement) ? value.replace(/\s*\n\s*/g, ', ') : value;
      if (kind === 'cc-exp' || kind === 'cc-exp-year') {
        text = expiryText(target, kind, value);
      }
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

  /**
   * Вибрана адреса чи картка: поле, з якого вибирали, — завжди, а решта полів його частини форми — якщо ще порожні.
   * Браузер дає значення лише для полів свого роду (адреса чи картка), і без CVV/CVC.
   */
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

  // ——— Збереження адреси чи картки після надсилання форми ———

  /** Що в полі: текст чи вибраний пункт списку (його текст, а для чисел — значення). */
  function textOf(item, numeric) {
    if (!(item instanceof HTMLSelectElement)) {
      return valueOf(item).trim();
    }
    if (isBlank(item)) {
      return '';
    }
    const option = optionsOf.call(item)[selectedIndexOf.get.call(item)];
    return (numeric && !Number.isNaN(numberIn(option.value)) ? option.value : option.text).trim();
  }

  /** Картка з частини форми: номер, ім'я власника, місяць і рік. CVV/CVC не читається. Без номера — null. */
  function cardOf(section) {
    const value = (kind) => {
      const item = section.find((entry) => entry.kind === kind);
      return item ? textOf(item.field, kind !== 'cc-name' && kind !== 'cc-number') : '';
    };
    const number = value('cc-number').replace(/[\s-]/g, '');
    if (!/^\d{12,19}$/.test(number)) {
      return null;
    }
    const expiry = value('cc-exp').match(/(\d{1,2})\s*[/\-.]?\s*(\d{2,4})/);
    const month = expiry ? expiry[1] : String(numberIn(value('cc-exp-month')) || '');
    const year = expiry ? expiry[2] : String(numberIn(value('cc-exp-year')) || '');
    return { number, holder: value('cc-name'), month, year };
  }

  /** Що ввели у форму: адреса — з частини, де заповнено найбільше полів адреси, і картка, якщо є. */
  function entered(target) {
    const form = target.form || (target.closest && target.closest('form')) || null;
    let best = null;
    let card = null;
    for (const section of sectionsIn(form)) {
      const values = {};
      for (const { field: item, kind } of section) {
        const value = isCardKind(kind) ? '' : textOf(item, false);
        if (value && !values[kind]) {
          values[kind] = value;
        }
      }
      if (!best || Object.keys(values).length > Object.keys(best.values).length) {
        best = { values, input: section[0].field };
      }
      card = card || cardOf(section);
    }
    const values = best && Object.keys(best.values).length >= 3 ? best.values : null;
    if (!values && !card) {
      return null;
    }
    const input = (card && sectionsIn(form).find((section) => cardOf(section))[0].field) || best.input;
    return { values, card, input };
  }

  let pending = null;
  let sent = '';

  /** Надсилання форми. Вдалося — якщо сторінка пішла чи поля зникли; лишилися кілька секунд — найпевніше, помилка. */
  function attempt(target) {
    const found = entered(target);
    if (!found || (pending && toJson([pending.values, pending.card]) === toJson([found.values, found.card]))) {
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
    const { values, card } = pending;
    pending = null;
    if (sent === toJson([values, card])) {
      return;
    }
    sent = toJson([values, card]);
    if (values) {
      send({ type: 'submitted', values });
    }
    if (card) {
      send({ type: 'submitted', form: 'card', values: card });
    }
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
