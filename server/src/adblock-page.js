// Блокувальник реклами на сторінці (server/src/adblock.rs). Скрипт додається до кожного документа вкладки
// ще до коду сайту: ховає рекламні блоки, виконує процедурні правила (`:has-text()`, `:upward()`, `:remove()`…)
// і запускає скриптлети uBlock Origin. Працює лише в головному документі сайту, для якого зібраний.
(host, selectors, procedural, runScriptlets) => {
  if (window !== window.top || location.hostname !== host) {
    return;
  }
  // Власні копії — до того, як сайт чи скриптлети їх підмінять.
  const { setTimeout, MutationObserver, CSSStyleSheet, XPathResult, getComputedStyle } = window;

  try {
    runScriptlets({});
  } catch {
    // Скриптлет, що впав, не заважає решті блокувальника.
  }

  // Прості правила — одна таблиця стилів, якої немає в DOM, тож сайт її не прибере.
  const rules = selectors.map((selector) => `${selector}{display:none!important}`);
  const scripted = [];
  for (const filter of procedural) {
    const [first, ...rest] = filter.selector;
    if (!rest.length && first?.type === 'css-selector' && filter.action?.type === 'style') {
      rules.push(`${first.arg}{${filter.action.arg}}`);
    } else {
      scripted.push({ ...filter, done: new WeakSet() });
    }
  }
  if (rules.length) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rules.join('\n'));
    const adopt = () => {
      if (!document.adoptedStyleSheets.includes(sheet)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
    };
    adopt();
    // Сайт може переписати adoptedStyleSheets цілком — повертаємо таблицю.
    document.addEventListener('DOMContentLoaded', adopt);
    window.addEventListener('load', adopt);
  }
  if (!scripted.length) {
    return;
  }

  // Аргумент — текст або /регулярний вираз/прапорці.
  const matcher = (arg, partial) => {
    const regex = /^\/(.+)\/([dgimsuy]*)$/.exec(arg);
    if (regex) {
      const pattern = new RegExp(regex[1], regex[2]);
      return (text) => pattern.test(text);
    }
    return partial ? (text) => text.includes(arg) : (text) => text === arg;
  };
  const root = (nodes) => nodes ?? [document.documentElement];
  const css =
    (pseudo) =>
    (nodes, arg) => {
      const colon = arg.indexOf(':');
      const name = arg.slice(0, colon).trim();
      const test = matcher(arg.slice(colon + 1).trim(), false);
      return root(nodes).filter((node) => test(getComputedStyle(node, pseudo).getPropertyValue(name)));
    };

  const operators = {
    'css-selector': (nodes, arg) => {
      if (!nodes) {
        return [...document.querySelectorAll(arg)];
      }
      const selector = arg.trimStart();
      if (selector[0] === '+' || selector[0] === '~') {
        const sibling = selector.slice(1).trim();
        return nodes.flatMap((node) => {
          const found = [];
          for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
            if (next.matches(sibling)) {
              found.push(next);
            }
            if (selector[0] === '+') {
              break;
            }
          }
          return found;
        });
      }
      if (selector[0] === '>' || selector !== arg) {
        return nodes.flatMap((node) => [...node.querySelectorAll(`:scope ${selector}`)]);
      }
      return nodes.filter((node) => node.matches(arg));
    },
    'has-text': (nodes, arg) => {
      const test = matcher(arg, true);
      return root(nodes).filter((node) => test(node.textContent));
    },
    'min-text-length': (nodes, arg) => root(nodes).filter((node) => node.textContent.length >= Number(arg)),
    'matches-css': css(null),
    'matches-css-before': css('::before'),
    'matches-css-after': css('::after'),
    'matches-attr': (nodes, arg) => {
      const [, rawName, rawValue] = /^"?(.+?)"?(?:="?(.*?)"?)?$/.exec(arg) ?? [];
      const name = matcher(rawName, false);
      const value = rawValue === undefined ? () => true : matcher(rawValue, false);
      return root(nodes).filter((node) => [...node.attributes].some((attribute) => name(attribute.name) && value(attribute.value)));
    },
    'matches-path': (nodes, arg) => (matcher(arg, true)(location.pathname + location.search) ? root(nodes) : []),
    upward: (nodes, arg) =>
      root(nodes)
        .map((node) => {
          if (!/^\d+$/.test(arg)) {
            return node.parentElement?.closest(arg);
          }
          let ancestor = node;
          for (let step = Number(arg); ancestor && step > 0; step--) {
            ancestor = ancestor.parentElement;
          }
          return ancestor;
        })
        .filter(Boolean),
    xpath: (nodes, arg) =>
      (nodes ?? [document]).flatMap((context) => {
        const result = document.evaluate(arg, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const found = [];
        for (let index = 0; index < result.snapshotLength; index++) {
          const node = result.snapshotItem(index);
          if (node.nodeType === Node.ELEMENT_NODE) {
            found.push(node);
          }
        }
        return found;
      }),
  };

  const apply = (filter, node) => {
    const action = filter.action;
    switch (action?.type) {
      case undefined:
        node.style.setProperty('display', 'none', 'important');
        filter.done.add(node);
        break;
      case 'style':
        node.style.cssText += `;${action.arg}`;
        filter.done.add(node);
        break;
      case 'remove':
        node.remove();
        break;
      case 'remove-attr':
        for (const name of action.arg.split('|')) {
          node.removeAttribute(name);
        }
        break;
      case 'remove-class':
        node.classList.remove(...action.arg.split('|'));
        break;
    }
  };

  let queued = false;
  const run = () => {
    queued = false;
    for (const filter of scripted) {
      try {
        const nodes = filter.selector.reduce((found, { type, arg }) => operators[type](found, arg), null) ?? [];
        for (const node of nodes) {
          if (!filter.done.has(node)) {
            apply(filter, node);
          }
        }
      } catch {
        // Правило з незнайомим оператором чи невалідним селектором пропускаємо.
      }
    }
  };
  // Сторінка змінюється постійно (стрічки, SPA) — правила застосовуються знову, не частіше ніж раз на 50 мс.
  const queue = () => {
    if (!queued) {
      queued = true;
      setTimeout(run, 50);
    }
  };
  new MutationObserver(queue).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  queue();
}
