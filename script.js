// Focus -> automatic break with an optional commit -> manual restart.
const $ = (id) => document.getElementById(id);
const cycle = new FocusCycle();
let sessionGoal = '';
let tickTimeout = null;
let displayedClock = null;
let alarmContext;
const alarms = {
  focus: { url: 'assets/focus-end.mp3', duration: 9.5 },
  break: { url: 'assets/break-end.mp3', duration: 2.6 },
};

function enableAlarm() {
  try {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Context) return;
    if (!alarmContext || alarmContext.state === 'closed') alarmContext = new Context();
    // Unlock audio during the user's Play click, without delaying the timer.
    alarmContext.resume().catch(() => {});
    // Focus completion sound: https://www.youtube.com/watch?v=u7Djn-G6uSk
    if (globalThis.location?.protocol === 'file:' || !globalThis.fetch) return;
    for (const alarm of Object.values(alarms)) {
      if (alarm.loading) continue;
      alarm.loading = fetch(alarm.url)
        .then((response) => {
          if (!response.ok) throw new Error('Sound unavailable');
          return response.arrayBuffer();
        })
        .then((data) => alarmContext.decodeAudioData(data))
        .then((buffer) => { alarm.buffer = buffer; })
        .catch(() => { alarm.loading = null; });
    }
  } catch {
    // Audio availability must never prevent a focus session from starting.
  }
}

function playAlarm(phase) {
  const alarm = alarms[phase];
  if (alarm.buffer && alarmContext?.state === 'running') {
    try {
      const sound = alarmContext.createBufferSource();
      const volume = alarmContext.createGain();
      sound.buffer = alarm.buffer;
      volume.gain.value = 0.5;
      sound.connect(volume);
      volume.connect(alarmContext.destination);
      sound.onended = () => { sound.disconnect(); volume.disconnect(); };
      sound.start(alarmContext.currentTime, 0, alarm.duration);
      return;
    } catch {
      // Try direct media playback if Web Audio fails.
    }
  }

  // Media elements can play local files even when fetch cannot load them.
  if (globalThis.Audio) {
    try {
      alarm.player ??= new globalThis.Audio(alarm.url);
      alarm.player.volume = 0.5;
      alarm.player.currentTime = 0;
      alarm.player.play().catch(playBeep);
      return;
    } catch {
      // Keep the beep if neither MP3 playback method is available.
    }
  }
  playBeep();
}

function playBeep() {
  if (!alarmContext || alarmContext.state !== 'running') return;
  try {
    const tone = alarmContext.createOscillator();
    const volume = alarmContext.createGain();
    const now = alarmContext.currentTime;
    tone.type = 'sine';
    tone.frequency.value = 880;
    volume.gain.setValueAtTime(0, now);
    volume.gain.linearRampToValueAtTime(0.08, now + 0.01);
    volume.gain.setValueAtTime(0.08, now + 0.04);
    volume.gain.linearRampToValueAtTime(0, now + 0.22);
    tone.connect(volume);
    volume.connect(alarmContext.destination);
    tone.onended = () => { tone.disconnect(); volume.disconnect(); };
    tone.start(now);
    tone.stop(now + 0.23);
  } catch {
    // A blocked or interrupted sound must not interrupt the cycle.
  }
}

function setGoalError(text = '') {
  $('goal-error').textContent = text;
  $('goal-error').hidden = !text;
  $('goal').setAttribute('aria-invalid', String(Boolean(text)));
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderClock() {
  if (!cycle.active) {
    if (displayedClock === 'ready') return;
    displayedClock = 'ready';
    $('time').textContent = '';
    $('time').setAttribute('aria-label', 'Remaining focus time');
    document.title = 'Focus Timer';
    return;
  }
  const remaining = cycle.timer.remainingMs;
  const label = cycle.phase === 'focus' ? 'Focus' : 'Break';
  const time = formatTime(remaining);
  const display = `${label}:${time}`;
  if (display === displayedClock) return;
  displayedClock = display;
  $('time').textContent = time;
  $('time').setAttribute('aria-label', `Remaining ${label.toLowerCase()} time: ${time}`);
  document.title = `${time} · ${label} · Focus Timer`;
}

function renderControls() {
  const isBreak = cycle.phase === 'break';
  if (!cycle.active) sessionGoal = '';
  $('timer-card').classList.toggle('break-card', isBreak);
  $('timer-card').dataset.stage = cycle.active ? 'running' : 'ready';
  $('timer-card').setAttribute('aria-label', isBreak ? 'Break timer' : 'Focus timer');
  $('setup').hidden = cycle.active;
  $('break-goals').hidden = !isBreak;
  $('break-goal-text').textContent = isBreak ? sessionGoal : '';
  $('clock-row').hidden = !cycle.active;
  $('timer-actions').hidden = cycle.active;
  $('goal').disabled = cycle.active;
  $('goal-input').dataset.empty = String($('goal').value.length === 0);
  $('profile').disabled = cycle.active;
  $('profile-trigger').disabled = cycle.active;
  syncProfilePicker();
  if (cycle.active) closeProfilePicker();
  $('play').disabled = cycle.active || !$('goal').value.trim();
  $('play').title = cycle.active ? (isBreak ? 'Break in progress' : 'Focus in progress') : 'Start focus';
  $('phase-status').textContent = cycle.notice;
  renderClock();
  scheduleTick();
}

function scheduleTick() {
  if (tickTimeout !== null) clearTimeout(tickTimeout);
  tickTimeout = null;
  if (!cycle.active) return;
  // Wake at the next displayed second, while timestamps remain the source of truth.
  const delay = Math.ceil(cycle.timer.remainingMs % 1000) || 1000;
  tickTimeout = setTimeout(tick, Math.max(1, delay));
}

function handleTransition(transition) {
  setGoalError();
  if (transition === 'cycle-ended') {
    commitForm.reset();
    saveCommit.disabled = true;
    commitForm.hidden = false;
    $('commit-saved').hidden = true;
    $('commit-error').hidden = true;
  }
  renderControls();
  playAlarm(transition === 'break-started' ? 'focus' : 'break');
  if (transition === 'cycle-ended' && !commitList.contains(document.activeElement)) {
    $('goal').focus({ preventScroll: true });
  }
}

function tick() {
  const transition = cycle.update();
  if (transition) handleTransition(transition);
  else {
    renderClock();
    scheduleTick();
  }
}

$('play').addEventListener('click', () => {
  // A click at the phase boundary must not start another focus session.
  const transition = cycle.update();
  if (transition) {
    handleTransition(transition);
    return;
  }
  if (cycle.active) return;
  if (cycle.phase === 'focus' && cycle.timer.state === 'ready' && !$('goal').value.trim()) {
    setGoalError('Please enter a short goal.');
    $('goal').focus();
    return;
  }
  setGoalError();
  enableAlarm();
  if (cycle.start()) {
    sessionGoal = $('goal').value;
    $('goal').value = '';
  }
  renderControls();
});

$('profile').addEventListener('change', () => {
  if (cycle.active) { $('profile').value = cycle.profile.id; return; }
  if (!FOCUS_PROFILES.some((profile) => profile.id === $('profile').value)) {
    $('profile').value = cycle.profile.id;
    return;
  }
  cycle.setProfile($('profile').value);
  setGoalError();
  renderControls();
});

// Keep the native select as the source of truth for the styled picker.
const profileSelect = $('profile');
const profileTrigger = $('profile-trigger');
const profileOptions = $('profile-options');
const profileItems = Array.from(profileSelect.options, (option) => {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'profile-option';
  item.id = `profile-option-${option.value}`;
  item.setAttribute('role', 'option');
  item.tabIndex = -1;
  item.dataset.value = option.value;
  item.textContent = option.textContent;
  item.addEventListener('click', () => {
    if (cycle.active) return;
    profileSelect.value = option.value;
    profileSelect.dispatchEvent(new Event('change'));
    closeProfilePicker(true);
  });
  profileOptions.append(item);
  return item;
});

function syncProfilePicker() {
  const selected = profileSelect.selectedOptions[0];
  $('profile-value').textContent = selected.textContent;
  profileTrigger.setAttribute('aria-label', `Focus and break duration: ${selected.textContent} minutes`);
  profileItems.forEach((item) => item.setAttribute('aria-selected', String(item.dataset.value === selected.value)));
}

function openProfilePicker(index = profileSelect.selectedIndex) {
  if (cycle.active) return;
  profileOptions.hidden = false;
  profileTrigger.setAttribute('aria-expanded', 'true');
  profileItems[index].focus({ preventScroll: true });
}

function closeProfilePicker(restoreFocus = false) {
  profileOptions.hidden = true;
  profileTrigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) profileTrigger.focus({ preventScroll: true });
}

profileTrigger.addEventListener('click', () => {
  if (profileOptions.hidden) openProfilePicker();
  else closeProfilePicker();
});
profileTrigger.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openProfilePicker();
  }
});
profileOptions.addEventListener('keydown', (event) => {
  const index = profileItems.indexOf(document.activeElement);
  let next = index;
  if (event.key === 'ArrowDown') next = (index + 1) % profileItems.length;
  else if (event.key === 'ArrowUp') next = (index - 1 + profileItems.length) % profileItems.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = profileItems.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    closeProfilePicker(true);
    return;
  } else if (event.key === 'Tab') {
    // Return to the trigger so Tab continues to the goal input in DOM order.
    closeProfilePicker(true);
    return;
  } else return;
  event.preventDefault();
  profileItems[next].focus({ preventScroll: true });
});
document.addEventListener('pointerdown', (event) => {
  if (!$('profile-choice').contains(event.target)) closeProfilePicker();
});
$('profile-choice').addEventListener('focusout', (event) => {
  if (!$('profile-choice').contains(event.relatedTarget)) closeProfilePicker();
});
profileSelect.hidden = true;
profileTrigger.hidden = false;

const goalInput = $('goal');
let previousGoal = { value: '', start: 0, end: 0 };

function rememberGoal() {
  previousGoal = { value: goalInput.value, start: goalInput.selectionStart, end: goalInput.selectionEnd };
}

function constrainGoal(event) {
  if (event.isComposing) return;
  if (goalInput.scrollHeight > goalInput.clientHeight + 1) {
    goalInput.value = previousGoal.value;
    goalInput.setSelectionRange(previousGoal.start, previousGoal.end);
    goalInput.scrollTop = 0;
    setGoalError();
  } else {
    rememberGoal();
    setGoalError();
  }
  $('goal-input').dataset.empty = String(goalInput.value.length === 0);
  $('play').disabled = cycle.active || !goalInput.value.trim();
}

goalInput.addEventListener('beforeinput', (event) => {
  if (!event.isComposing) rememberGoal();
});
goalInput.addEventListener('compositionstart', rememberGoal);
goalInput.addEventListener('compositionend', constrainGoal);
goalInput.addEventListener('input', constrainGoal);

const commitForm = $('commit-form');
const commitMessage = $('commit-message');
const saveCommit = $('save-commit');
const commitList = $('commit-list');
const commitPrefix = 'focus-timer-legacy:commit:';
const commitDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function loadCommits() {
  try {
    const storage = globalThis.localStorage;
    const commits = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(commitPrefix)) continue;
      try {
        const commit = JSON.parse(storage.getItem(key));
        if (typeof commit?.message === 'string' && typeof commit.goal === 'string'
          && Number.isFinite(commit.createdAt) && Number.isFinite(new Date(commit.createdAt).getTime())
          && Number.isInteger(commit.focusMinutes) && commit.focusMinutes > 0) {
          commits.push(commit);
        }
      } catch {
        // A damaged entry should not hide the rest of the history.
      }
    }
    return commits.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

function createCommitItem(commit) {
  const { focusMinutes } = commit;
  // Earlier commits stored only the focus duration, which identified their profile.
  const breakMinutes = Number.isInteger(commit.breakMinutes) && commit.breakMinutes > 0
    ? commit.breakMinutes
    : FOCUS_PROFILES.find((entry) => entry.focusMinutes === focusMinutes)?.breakMinutes;
  const item = document.createElement('li');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const date = document.createElement('time');
  date.dateTime = new Date(commit.createdAt).toISOString();
  date.textContent = commitDateFormat.format(commit.createdAt);
  const profile = document.createElement('span');
  profile.className = 'commit-summary-profile';
  profile.textContent = breakMinutes ? `${focusMinutes} + ${breakMinutes} min` : `${focusMinutes} min focus`;
  const message = document.createElement('span');
  message.className = 'commit-summary-message';
  message.textContent = commit.message;
  summary.append(date, profile, message);

  const fields = document.createElement('dl');
  fields.className = 'commit-details';
  const values = [['Original goal', commit.goal], ['Focus time', `${focusMinutes} min`]];
  if (breakMinutes) values.push(['Break time', `${breakMinutes} min`]);
  for (const [label, value] of values) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    fields.append(term, description);
  }
  details.append(summary, fields);
  item.append(details);
  return item;
}

commitMessage.addEventListener('input', () => {
  saveCommit.disabled = !commitMessage.value.trim();
  $('commit-error').hidden = true;
});
commitForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const message = commitMessage.value.trim();
  if (cycle.phase !== 'break' || commitForm.hidden || !message) return;
  const { focusMinutes, breakMinutes } = cycle.profile;
  const commit = { message, goal: sessionGoal, focusMinutes, breakMinutes, createdAt: Date.now() };
  try {
    // A separate key per commit keeps simultaneous writes in different tabs independent.
    const id = globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-');
    globalThis.localStorage.setItem(commitPrefix + id, JSON.stringify(commit));
  } catch {
    $('commit-error').textContent = 'Could not save the commit in this browser. Please try again.';
    $('commit-error').hidden = false;
    return;
  }
  commitList.prepend(createCommitItem(commit));
  $('commits-empty').hidden = true;
  commitForm.hidden = true;
  $('commit-saved').hidden = false;
  $('commit-saved').focus({ preventScroll: true });
});

const savedCommits = loadCommits();
for (const commit of savedCommits) commitList.append(createCommitItem(commit));
$('commits-empty').hidden = savedCommits.length > 0;

document.addEventListener('visibilitychange', tick);
renderControls();
$('goal').focus({ preventScroll: true });
