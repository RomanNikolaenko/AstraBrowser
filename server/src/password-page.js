(token) => {
  // Паролі на сторінці сайту (server/src/passwords.rs): після входу просить браузер запропонувати зберегти пароль,
  // а коли користувач стає в поле входу — показує збережені облікові записи й підставляє вибраний.
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
  const send = (message) => post(toJson({ astra: 'password', token, ...message }));
  const { get: getValue, set: setValue } = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const addListener = EventTarget.prototype.addEventListener;
  const listen = (target, type, handler) => addListener.call(target, type, handler, true);
  const setTimer = window.setTimeout.bind(window);
  const setRepeat = window.setInterval.bind(window);
  const stopRepeat = window.clearInterval.bind(window);

  const valueOf = (input) => getValue.call(input);
  const isInput = (node) => node instanceof HTMLInputElement;
  const isPassword = (node) => isInput(node) && node.type === 'password';
  const isUsername = (node) =>
    isInput(node) && (['text', 'email', 'tel'].includes(node.type) || /\busername\b/.test(node.autocomplete));
  const visible = (node) =>
    node.isConnected && !node.disabled && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const inputsNear = (node) => [...(node.form || document).querySelectorAll('input')];
  // Справжня ціль події — й у відкритому shadow DOM сайту.
  const targetOf = (event) => event.composedPath()[0];

  /** Поле імені для поля пароля: з autocomplete="username", інакше найближче текстове перед паролем. */
  function usernameFor(password, filled) {
    const inputs = inputsNear(password);
    const before = inputs.slice(0, inputs.indexOf(password)).reverse().filter(isUsername);
    const ok = (input) => !filled || valueOf(input).trim();
    return (
      inputs.find((input) => isUsername(input) && /\busername\b/.test(input.autocomplete) && ok(input)) ||
      before.find((input) => visible(input) && ok(input)) ||
      // Вхід у два кроки (як у Google): ім'я з першого кроку лишається в прихованому полі.
      (filled && before.find((input) => valueOf(input).trim())) ||
      null
    );
  }

  /** Поле пароля, до якого належить поле імені. */
  function passwordFor(username) {
    const inputs = inputsNear(username);
    return inputs.slice(inputs.indexOf(username) + 1).find((input) => isPassword(input) && visible(input)) || null;
  }

  // ——— Збереження пароля після входу ———

  let pending = null;
  let sent = '';

  /** Що ввели в поля входу поряд із `target` (у формі, а без неї — на всій сторінці). */
  function credentials(target) {
    const scope = (target.closest && target.closest('form')) || document;
    const passwords = [...scope.querySelectorAll('input[type=password]')].filter((input) => valueOf(input));
    // Зміна пароля: новий — з autocomplete="new-password".
    const password = passwords.find((input) => input.autocomplete === 'new-password') || passwords[0];
    if (!password) {
      return null;
    }
    const username = usernameFor(password, true);
    return { input: password, username: username ? valueOf(username).trim() : '', password: valueOf(password) };
  }

  /** Спроба входу. Вдалася — якщо сторінка пішла чи поле пароля зникло; лишилося на місці кілька секунд — пароль, найпевніше, хибний. */
  function attempt(target) {
    const found = credentials(target);
    if (!found || (pending && pending.username === found.username && pending.password === found.password)) {
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
    const { username, password } = pending;
    pending = null;
    if (sent === username + '\n' + password) {
      return;
    }
    sent = username + '\n' + password;
    accounts = null;
    send({ type: 'submitted', username, password });
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
  listen(window, 'pagehide', submitted);

  // ——— Збережені облікові записи в полі входу ———

  let accounts = null;
  let asked = false;
  /** Поле, у якому стоїть користувач, і поля входу, які заповнити. */
  let field = null;
  let chooser = null;
  let selected = -1;

  function enter(input) {
    const password = isPassword(input) ? input : isUsername(input) ? passwordFor(input) : null;
    if (!password) {
      return hide();
    }
    field = { input, password, username: isPassword(input) ? usernameFor(password, false) : input };
    if (accounts) {
      show();
    } else if (!asked) {
      asked = true;
      send({ type: 'accounts' });
    }
  }

  function show() {
    if (!field || !accounts || !accounts.length || !visible(field.input)) {
      return hide();
    }
    chooser = chooser || build();
    selected = -1;
    render();
    if (!chooser.host.isConnected) {
      document.documentElement.append(chooser.host);
    }
    if (!chooser.host.matches(':popover-open')) {
      chooser.host.showPopover();
    }
    place();
  }

  function hide() {
    if (chooser && chooser.host.isConnected) {
      chooser.host.remove();
    }
    selected = -1;
  }

  function place() {
    if (!chooser || !chooser.host.isConnected || !field) {
      return;
    }
    const rect = field.input.getBoundingClientRect();
    const height = chooser.list.offsetHeight;
    const below = rect.bottom + 4 + height <= innerHeight || rect.top < height + 4;
    const style = chooser.host.style;
    style.setProperty('left', `${Math.max(4, Math.min(rect.left, innerWidth - chooser.list.offsetWidth - 4))}px`, 'important');
    style.setProperty('top', `${below ? rect.bottom + 4 : rect.top - height - 4}px`, 'important');
    style.setProperty('min-width', `${Math.max(rect.width, 240)}px`, 'important');
  }

  function build() {
    const host = document.createElement('astra-passwords');
    host.setAttribute('popover', 'manual');
    // Стилі сайту не мають зачепити список: усе своє — з !important.
    for (const [name, value] of [
      ['all', 'initial'],
      ['position', 'fixed'],
      ['inset', 'auto'],
      ['margin', '0'],
      ['padding', '0'],
      ['border', '0'],
      ['background', 'transparent'],
      ['overflow', 'visible'],
      ['display', 'block'],
      ['z-index', '2147483647'],
    ]) {
      host.style.setProperty(name, value, 'important');
    }
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .list { box-sizing: border-box; max-width: 380px; padding: 6px; color: #1f2333; background: #fff;
        border: 1px solid rgb(0 0 0 / 12%); border-radius: 12px; box-shadow: 0 12px 32px rgb(0 0 0 / 18%);
        font: 14px/1.3 "Segoe UI", system-ui, sans-serif; }
      .item { display: flex; gap: 10px; align-items: center; box-sizing: border-box; width: 100%; padding: 8px 10px;
        color: inherit; font: inherit; text-align: left; cursor: pointer; background: transparent; border: 0; border-radius: 8px; }
      .item:hover, .item.selected { background: rgb(124 92 255 / 12%); }
      .icon { flex: none; width: 18px; height: 18px; color: #7c5cff; }
      .text { display: grid; min-width: 0; }
      .name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .hint, .manage { font-size: 12px; color: #6b7280; }
      .divider { height: 1px; margin: 4px 6px; background: rgb(0 0 0 / 8%); }
      @media (prefers-color-scheme: dark) {
        .list { color: #e7e9f2; background: #1b2030; border-color: rgb(255 255 255 / 10%); }
        .hint, .manage { color: #9aa1b5; }
        .divider { background: rgb(255 255 255 / 8%); }
      }
    </style><div class="list" role="listbox" aria-label="Збережені паролі"></div>`;
    const list = root.querySelector('.list');
    // Клік по списку не забирає фокус із поля.
    addListener.call(list, 'pointerdown', (event) => event.preventDefault());
    addListener.call(list, 'click', (event) => {
      const item = event.isTrusted && event.target.closest('[data-index]');
      if (item) {
        pick(Number(item.dataset.index));
      }
    });
    return { host, list };
  }

  const KEY_ICON =
    '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15.5" r="4"/><path d="M10.9 12.6 19.5 4M16.5 7l2.5 2.5M14 9.5l2 2"/></svg>';

  function render() {
    const list = chooser.list;
    list.replaceChildren();
    accounts.forEach((account, index) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'item' + (index === selected ? ' selected' : '');
      item.dataset.index = String(index);
      item.setAttribute('role', 'option');
      item.innerHTML = `${KEY_ICON}<span class="text"><span class="name"></span><span class="hint">Збережений пароль</span></span>`;
      item.querySelector('.name').textContent = account.username || 'Без імені користувача';
      list.append(item);
    });
    const divider = document.createElement('div');
    divider.className = 'divider';
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.className = 'item manage' + (selected === accounts.length ? ' selected' : '');
    manage.dataset.index = '-1';
    manage.textContent = 'Керувати паролями…';
    list.append(divider, manage);
  }

  function pick(index) {
    if (index < 0) {
      hide();
      send({ type: 'manage' });
    } else if (accounts && accounts[index]) {
      send({ type: 'fill', username: accounts[index].username });
    }
  }

  function put(input, value) {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fill(data) {
    if (!field) {
      return;
    }
    if (field.username && data.username && valueOf(field.username) !== data.username) {
      put(field.username, data.username);
    }
    put(field.password, data.password);
    hide();
  }

  onMessage('message', (event) => {
    const data = event.data;
    if (!data || data.astra !== 'password') {
      return;
    }
    if (data.type === 'accounts') {
      accounts = Array.isArray(data.accounts) ? data.accounts : [];
      if (field && document.activeElement === field.input) {
        show();
      }
    } else if (data.type === 'fill' && typeof data.password === 'string') {
      fill(data);
    }
  });

  listen(document, 'focusin', (event) => {
    const target = targetOf(event);
    if (event.isTrusted && isInput(target)) {
      enter(target);
    }
  });
  listen(document, 'pointerdown', (event) => {
    const target = targetOf(event);
    if (!event.isTrusted || (chooser && event.target === chooser.host)) {
      return;
    }
    // Клік у поле, де вже стоїть курсор, — знову показати список.
    if (isInput(target) && target === document.activeElement) {
      enter(target);
    } else if (!field || target !== field.input) {
      hide();
    }
  });
  listen(document, 'focusout', (event) => {
    if (field && targetOf(event) === field.input) {
      setTimer(() => {
        if (!field || document.activeElement !== field.input) {
          hide();
        }
      }, 150);
    }
  });
  listen(document, 'keydown', (event) => {
    const target = targetOf(event);
    const open = chooser && chooser.host.isConnected && field && target === field.input;
    if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const count = accounts.length + 1;
      selected = event.key === 'ArrowDown' ? (selected + 1) % count : selected <= 0 ? count - 1 : selected - 1;
      render();
    } else if (open && event.key === 'Enter' && selected >= 0) {
      event.preventDefault();
      event.stopPropagation();
      pick(selected === accounts.length ? -1 : selected);
    } else if (open && event.key === 'Escape') {
      hide();
    } else if (event.isTrusted && event.key === 'Enter' && (isPassword(target) || isUsername(target))) {
      attempt(target);
    }
  });
  listen(window, 'scroll', place);
  listen(window, 'resize', place);
}
