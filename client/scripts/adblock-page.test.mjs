import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const script = readFileSync(new URL('../../server/src/adblock-page.js', import.meta.url), 'utf8');

function setup(classes, action) {
  const dom = new JSDOM(`<div id="target" class="${classes}"></div>`, {
    url: 'https://example.test/',
    runScripts: 'outside-only',
  });
  const queue = [];
  const { window } = dom;
  window.setTimeout = (callback) => queue.push(callback);
  const invoke = window.eval(`(${script})`);
  // Скриптлетів у цих правилах немає — їх запуск нічого не робить.
  invoke('example.test', [], [{ selector: [{ type: 'css-selector', arg: '#target' }], action }], () => undefined);
  const tick = async () => {
    // MutationObserver доставляє свої записи в microtask, до наступного таймера сторінки.
    await Promise.resolve();
    const callback = queue.shift();
    callback?.();
    await Promise.resolve();
  };
  return { dom, target: window.document.querySelector('#target'), queue, tick };
}

test('class-removal rules settle after their own mutation, then handle a class added again', async () => {
  const { dom, target, queue, tick } = setup('scroll-lock keep', { type: 'remove-class', arg: 'scroll-lock|missing' });
  try {
    await tick();
    assert.equal(target.className, 'keep');
    await tick();
    assert.equal(queue.length, 0, 'a no-op class removal must not keep the observer running');

    target.classList.add('scroll-lock');
    await tick();
    assert.equal(target.className, 'keep', 'a later site mutation must still be corrected');
    await tick();
    assert.equal(queue.length, 0);
  } finally {
    dom.window.close();
  }
});

test('a rule matching an element without the unwanted class does not mutate it', async () => {
  const { dom, target, queue, tick } = setup('keep', { type: 'remove-class', arg: 'missing' });
  try {
    let mutations = 0;
    const observer = new dom.window.MutationObserver((records) => (mutations += records.length));
    observer.observe(target, { attributes: true });
    await tick();
    assert.equal(target.className, 'keep');
    assert.equal(mutations, 0);
    assert.equal(queue.length, 0);
  } finally {
    dom.window.close();
  }
});
