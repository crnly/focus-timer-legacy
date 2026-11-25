const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FOCUS_PROFILES } = require('../cycle.js');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// A small DOM adapter exercises the real UI script and clock together.
// Layout, native browser input and rendered line wrapping still need browser QA.
function app({ AudioContext, fetch, storage = new Map() } = {}) {
  let now = 0;
  let pendingTick = null;
  let timerId = 0;
  let document;
  class Element extends EventTarget {
    constructor() {
      super();
      this.hidden = false;
      this.value = this.textContent = '';
      this.dataset = {};
      this.style = {};
      this.children = [];
      this.attributes = {};
      this.selectionStart = this.selectionEnd = 0;
      this.clientHeight = this.scrollHeight = 124;
      this.classList = { toggle() {} };
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(...children) { this.children.push(...children); }
    prepend(child) { this.children.unshift(child); }
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  const elements = new Map();
  for (const [, id, attrs] of html.matchAll(/id="([^"]+)"([^>]*)>/g)) {
    const element = new Element();
    element.hidden = /\bhidden\b/.test(attrs);
    element.disabled = /\bdisabled\b/.test(attrs);
    elements.set(id, element);
  }
  const get = id => {
    assert.ok(elements.has(id), `Missing element: ${id}`);
    return elements.get(id);
  };
  document = new EventTarget();
  document.getElementById = get;
  document.createElement = () => new Element();
  get('commit-form').reset = () => { get('commit-message').value = ''; };
  get('profile-choice').children = [get('profile'), get('profile-trigger'), get('profile-options')];
  const select = get('profile');
  select.options = Array.from(html.matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g),
    ([, value, attrs, textContent]) => ({ value, textContent, selected: /\bselected\b/.test(attrs) }));
  select.value = select.options.find(option => option.selected).value;
  Object.defineProperty(select, 'selectedIndex', { get: () => select.options.findIndex(option => option.value === select.value) });
  Object.defineProperty(select, 'selectedOptions', { get: () => [select.options[select.selectedIndex]] });
  let clockWrites = 0;
  let clockText = '';
  Object.defineProperty(get('time'), 'textContent', {
    get: () => clockText,
    set: value => { clockText = value; clockWrites++; },
  });
  const context = vm.createContext({
    document, Event, crypto: globalThis.crypto,
    Date: class extends Date { static now() { return now; } },
    localStorage: {
      get length() { return storage.size; },
      key: (index) => [...storage.keys()][index],
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    ...(AudioContext ? { AudioContext } : {}),
    ...(fetch ? { fetch } : {}),
    setTimeout(fn, delay) {
      pendingTick = { fn, at: now + delay, id: ++timerId };
      return timerId;
    },
    clearTimeout(id) { if (pendingTick?.id === id) pendingTick = null; },
  });
  for (const file of ['timer.js', 'cycle.js', 'script.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const event = (target, type, properties = {}) => {
    const value = Object.assign(new Event(type, { cancelable: true }), properties);
    target.dispatchEvent(value);
  };
  const enter = value => {
    event(get('goal'), 'beforeinput');
    get('goal').value = value;
    event(get('goal'), 'input');
  };
  const choose = value => {
    const index = select.options.findIndex(option => option.value === value);
    assert.ok(index >= 0);
    event(get('profile-trigger'), 'click');
    event(get('profile-options').children[index], 'click');
  };
  return {
    get, document, event, enter, choose,
    clockWrites: () => clockWrites,
    nextTickIn: () => pendingTick ? pendingTick.at - now : null,
    advance(ms) {
      now += ms;
      if (pendingTick && pendingTick.at <= now) {
        const callback = pendingTick.fn;
        pendingTick = null;
        callback();
      }
    },
  };
}

test('main entry point references existing local scripts, styles and images', () => {
  const options = Array.from(html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g),
    ([, id, label]) => [id, label]);
  assert.deepEqual(options, FOCUS_PROFILES.map(({ id, focusMinutes, breakMinutes }) =>
    [id, `${focusMinutes} + ${breakMinutes}`]));
  assert.ok(!options.some(([id]) => id === '1-1'));
  const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const [, reference] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    assert.ok(!reference.startsWith('/'), `Use a project-relative path: ${reference}`);
    const file = reference.split(/[?#]/)[0];
    assert.ok(fs.existsSync(path.join(root, file)), `Missing asset: ${reference}`);
  }
  const script = fs.readFileSync(path.join(root, 'script.js'), 'utf8');
  for (const [, id] of script.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(id), `Missing DOM id: ${id}`);
});

test('Play requires a goal and starts the selected 40 + 11 profile', () => {
  const ui = app();
  assert.equal(ui.get('play').disabled, true);
  assert.equal(ui.get('time').textContent, '');
  ui.enter('   ');
  assert.equal(ui.get('play').disabled, true);
  ui.choose('40-10');
  ui.enter('Complete the draft');
  assert.equal(ui.get('play').disabled, false);
  ui.event(ui.get('play'), 'click');
  assert.equal(ui.get('time').textContent, '40:00');
  assert.equal(ui.get('setup').hidden, true);
  assert.equal(ui.get('timer-actions').hidden, true);
  assert.equal(ui.get('goal').value, '');
  assert.equal(ui.get('profile-trigger').disabled, true);
});

test('50 + 11 shows goals during break and returns to the empty start view', () => {
  const ui = app();
  const goal = 'Complete the draft\nReview <section> markup\nSend the update\nPlan tomorrow';
  ui.choose('50-10');
  ui.enter(goal);
  ui.event(ui.get('play'), 'click');
  assert.equal(ui.get('break-goals').hidden, true);
  assert.equal(ui.get('break-goal-text').textContent, '');
  ui.advance(50 * 60_000);
  assert.equal(ui.get('time').textContent, '11:00');
  assert.equal(ui.get('break-goals').hidden, false);
  assert.equal(ui.get('break-goal-text').textContent, goal);
  ui.advance(11 * 60_000);
  assert.equal(ui.get('break-goals').hidden, true);
  assert.equal(ui.get('break-goal-text').textContent, '');
  assert.equal(ui.get('setup').hidden, false);
  assert.equal(ui.get('timer-actions').hidden, false);
  assert.equal(ui.get('goal').value, '');
  assert.equal(ui.get('play').disabled, true);
  assert.equal(ui.get('time').textContent, '');
  assert.equal(ui.document.activeElement, ui.get('goal'));
  ui.enter('A fresh goal');
  ui.event(ui.get('play'), 'click');
  ui.advance(50 * 60_000);
  assert.equal(ui.get('break-goal-text').textContent, 'A fresh goal');
  ui.advance(60 * 60_000);
  assert.equal(ui.get('break-goal-text').textContent, '');
  assert.equal(ui.get('setup').hidden, false);
});

test('a break commit stores its message, date, original goal and focus length across reloads', () => {
  const storage = new Map();
  const ui = app({ storage });
  const form = ui.get('commit-form');
  const message = ui.get('commit-message');
  const button = ui.get('save-commit');
  function submit(text) {
    message.value = text;
    ui.event(message, 'input');
    ui.event(form, 'submit');
  }

  assert.equal(ui.get('commits-empty').hidden, false);
  ui.enter('First goal\nKeep <markup> as text');
  ui.event(ui.get('play'), 'click');
  assert.equal(ui.get('break-goals').hidden, true);
  ui.advance(25 * 60_000);
  assert.equal(ui.get('break-goals').hidden, false);
  assert.equal(form.hidden, false);
  assert.equal(button.disabled, true);
  submit('   ');
  assert.equal(storage.size, 0);
  submit('  Finished the draft  ');
  assert.equal(storage.size, 1);
  assert.equal(form.hidden, true);
  assert.equal(ui.get('commit-saved').hidden, false);
  assert.equal(ui.get('commits-empty').hidden, true);
  submit('Duplicate');
  assert.equal(storage.size, 1);

  ui.advance(6 * 60_000);
  assert.equal(message.value, '');
  ui.choose('15-5');
  ui.enter('Second goal');
  ui.event(ui.get('play'), 'click');
  ui.advance(15 * 60_000);
  submit('Reviewed the draft');

  const reloaded = app({ storage });
  const entries = reloaded.get('commit-list').children;
  assert.equal(entries.length, 2);
  const [[latestSummary, latestFields], [firstSummary, firstFields]] = entries.map(entry => entry.children[0].children);
  assert.equal(latestSummary.children[1].textContent, 'Reviewed the draft');
  assert.equal(latestFields.children[3].textContent, '15 min');
  assert.equal(firstSummary.children[0].dateTime, new Date(25 * 60_000).toISOString());
  assert.ok(firstSummary.children[0].textContent);
  assert.equal(firstSummary.children[1].textContent, 'Finished the draft');
  assert.equal(firstFields.children[1].textContent, 'First goal\nKeep <markup> as text');
  assert.equal(firstFields.children[3].textContent, '25 min');
});

test('a failed commit write keeps the note available for retry during the break', () => {
  const storage = new Map();
  const write = storage.set.bind(storage);
  storage.set = () => { throw new Error('Storage unavailable'); };
  const ui = app({ storage });
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  ui.advance(25 * 60_000);
  ui.get('commit-message').value = 'Draft finished';
  ui.event(ui.get('commit-form'), 'submit');
  assert.equal(ui.get('commit-error').hidden, false);
  assert.equal(ui.get('commit-form').hidden, false);
  assert.equal(ui.get('commit-message').value, 'Draft finished');
  assert.equal(ui.get('commit-list').children.length, 0);
  storage.set = write;
  ui.event(ui.get('commit-form'), 'submit');
  assert.equal(ui.get('commit-saved').hidden, false);
  assert.equal(storage.size, 1);
});

test('profile picker supports arrow keys, Home, End and Escape without changing selection', () => {
  const ui = app();
  const trigger = ui.get('profile-trigger');
  const options = ui.get('profile-options');
  ui.event(trigger, 'keydown', { key: 'ArrowDown' });
  assert.equal(options.hidden, false);
  ui.event(options, 'keydown', { key: 'End' });
  assert.equal(ui.document.activeElement, options.children.at(-1));
  ui.event(options, 'keydown', { key: 'ArrowUp' });
  assert.equal(ui.document.activeElement, options.children.at(-2));
  ui.event(options, 'keydown', { key: 'Home' });
  assert.equal(ui.document.activeElement, options.children[0]);
  ui.event(options, 'keydown', { key: 'Escape' });
  assert.equal(options.hidden, true);
  assert.equal(ui.document.activeElement, trigger);
  assert.equal(ui.get('profile').value, '25-5');
});

test('overflowing goal edits are rejected silently and a shorter correction is accepted', () => {
  const ui = app();
  const goal = ui.get('goal');
  const valid = 'One\nTwo\nThree\nFour';
  ui.enter(valid);
  // Simulate the textarea reporting a fifth rendered line.
  goal.scrollHeight = 150;
  ui.enter(valid + '\nFive');
  assert.equal(goal.value, valid);
  assert.equal(ui.get('goal-error').hidden, true);
  assert.equal(ui.get('play').disabled, false);
  goal.scrollHeight = goal.clientHeight;
  ui.enter('Shorter goal');
  assert.equal(goal.value, 'Shorter goal');
});

test('one beep sounds at each phase end and repeated updates do not repeat it', () => {
  let beeps = 0;
  let unlocked = 0;
  class AudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() { unlocked++; return Promise.resolve(); }
    createOscillator() {
      return { frequency: {}, connect() {}, disconnect() {}, start() { beeps++; }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  }
  const ui = app({ AudioContext });
  assert.equal(unlocked, 0);
  ui.enter('Complete the draft');
  ui.event(ui.get('play'), 'click');
  assert.equal(unlocked, 1);
  assert.equal(beeps, 0);
  ui.advance(25 * 60_000);
  assert.equal(beeps, 1);
  ui.advance(1_000);
  assert.equal(beeps, 1);
  ui.advance(6 * 60_000);
  assert.equal(beeps, 2);
  ui.advance(1_000);
  assert.equal(beeps, 2);
  assert.equal(ui.get('setup').hidden, false);
});

test('a rejected audio unlock does not interrupt the timer or produce an unhandled rejection', async () => {
  class AudioContext {
    state = 'suspended';
    resume() { return Promise.reject(new Error('Audio blocked')); }
  }
  const ui = app({ AudioContext });
  ui.enter('Complete the draft');
  ui.event(ui.get('play'), 'click');
  await Promise.resolve();
  assert.equal(ui.get('time').textContent, '25:00');
  ui.advance(25 * 60_000);
  assert.equal(ui.get('time').textContent, '06:00');
  ui.advance(6 * 60_000);
  assert.equal(ui.get('setup').hidden, false);
  assert.equal(ui.get('play').disabled, true);
});

function sampleAudio() {
  const calls = { samples: 0, beeps: 0, decodes: 0, durations: [], sources: [] };
  class AudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    decodeAudioData(data) {
      calls.decodes++;
      const source = new Uint8Array(data)[0];
      return Promise.resolve({ duration: source === 1 ? 9.7 : 2.6, source });
    }
    createBufferSource() {
      return { connect() {}, disconnect() {}, start(when, offset, duration) { calls.samples++; calls.durations.push(duration); calls.sources.push(this.buffer.source); } };
    }
    createOscillator() {
      return { frequency: {}, connect() {}, disconnect() {}, start() { calls.beeps++; }, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} };
    }
  }
  return { AudioContext, calls };
}

test('each phase plays its own completion sound once and both files are cached', async () => {
  const audio = sampleAudio();
  let requests = 0;
  const ui = app({
    AudioContext: audio.AudioContext,
    fetch(url) {
      assert.ok(['assets/focus-end.mp3', 'assets/break-end.mp3'].includes(url));
      assert.ok(fs.statSync(path.join(root, url)).size > 0);
      requests++;
      const data = new Uint8Array([url === 'assets/focus-end.mp3' ? 1 : 2]);
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(data.buffer) });
    },
  });
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  await new Promise(setImmediate);
  assert.equal(audio.calls.samples, 0);
  assert.equal(requests, 2);
  assert.equal(audio.calls.decodes, 2);
  ui.advance(25 * 60_000);
  assert.equal(audio.calls.samples, 1);
  ui.advance(1_000);
  assert.equal(audio.calls.samples, 1);
  ui.advance(6 * 60_000);
  assert.equal(audio.calls.samples, 2);
  assert.deepEqual(audio.calls.durations, [9.5, 2.6]);
  assert.deepEqual(audio.calls.sources, [1, 2]);
  assert.equal(audio.calls.beeps, 0);
  ui.enter('A new goal');
  ui.event(ui.get('play'), 'click');
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  assert.equal(audio.calls.decodes, 2);
});

test('a failed sound download keeps the original beep and the full timer cycle working', async () => {
  const audio = sampleAudio();
  const ui = app({ AudioContext: audio.AudioContext, fetch: () => Promise.reject(new Error('Offline')) });
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  await new Promise(setImmediate);
  ui.advance(25 * 60_000);
  assert.equal(audio.calls.beeps, 1);
  ui.advance(6 * 60_000);
  assert.equal(audio.calls.beeps, 2);
  assert.equal(audio.calls.samples, 0);
  assert.equal(ui.get('setup').hidden, false);
});

test('a missing break sound falls back to the beep without replaying the focus sound', async () => {
  const audio = sampleAudio();
  const ui = app({
    AudioContext: audio.AudioContext,
    fetch(url) {
      if (url === 'assets/break-end.mp3') return Promise.reject(new Error('Unavailable'));
      return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new Uint8Array([1]).buffer) });
    },
  });
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  await new Promise(setImmediate);
  ui.advance(25 * 60_000);
  assert.deepEqual(audio.calls.sources, [1]);
  ui.advance(6 * 60_000);
  assert.deepEqual(audio.calls.sources, [1]);
  assert.equal(audio.calls.beeps, 1);
  assert.equal(ui.get('setup').hidden, false);
});

test('the idle app schedules no polling and a running timer updates at second boundaries', () => {
  const ui = app();
  const idleWrites = ui.clockWrites();
  assert.equal(ui.nextTickIn(), null);
  ui.advance(60 * 60_000);
  assert.equal(ui.clockWrites(), idleWrites);
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  assert.equal(ui.get('time').textContent, '25:00');
  assert.equal(ui.nextTickIn(), 1000);
  const startWrites = ui.clockWrites();
  ui.advance(999);
  assert.equal(ui.get('time').textContent, '25:00');
  assert.equal(ui.clockWrites(), startWrites);
  ui.advance(1);
  assert.equal(ui.get('time').textContent, '24:59');
  assert.equal(ui.clockWrites(), startWrites + 1);
  assert.equal(ui.nextTickIn(), 1000);
  ui.advance(31 * 60_000 - 1000);
  assert.equal(ui.get('setup').hidden, false);
  assert.equal(ui.nextTickIn(), null);
});

test('visibility updates preserve the clock display and align the next callback to the deadline', () => {
  const ui = app();
  ui.enter('Finish the draft');
  ui.event(ui.get('play'), 'click');
  const startWrites = ui.clockWrites();
  ui.advance(250);
  ui.event(ui.document, 'visibilitychange');
  assert.equal(ui.clockWrites(), startWrites);
  assert.equal(ui.nextTickIn(), 750);
  ui.advance(750);
  assert.equal(ui.get('time').textContent, '24:59');
  ui.advance(25 * 60_000 - 1000);
  assert.equal(ui.get('time').textContent, '06:00');
  assert.equal(ui.nextTickIn(), 1000);
  ui.advance(6 * 60_000);
  assert.equal(ui.nextTickIn(), null);
  assert.equal(ui.get('setup').hidden, false);
});
