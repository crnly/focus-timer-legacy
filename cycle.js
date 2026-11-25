// Logic for one focus-break cycle, independent of the interface.
const CycleTimer = typeof module !== 'undefined'
  ? require('./timer.js').CountdownTimer
  : CountdownTimer;

const FOCUS_PROFILES = Object.freeze([
  ['1-1', 1, 1],
  ['15-5', 15, 6],
  ['20-5', 20, 6],
  ['25-5', 25, 6],
  ['30-10', 30, 11],
  ['35-10', 35, 11],
  ['40-10', 40, 11],
  ['50-10', 50, 11],
].map(([id, focusMinutes, breakMinutes]) => Object.freeze({ id, focusMinutes, breakMinutes })));

class FocusCycle {
  constructor(profileId = '25-5', clock = Date.now) {
    this.clock = clock;
    this.breakSerial = 0;
    this.profile = this.getProfile(profileId);
    this.timer = new CycleTimer(this.profile.focusMinutes * 60_000, clock);
    this.phase = 'focus';
    this.notice = '';
  }

  getProfile(id) {
    const profile = FOCUS_PROFILES.find((entry) => entry.id === id);
    if (!profile) throw new RangeError('Unknown time profile.');
    return profile;
  }

  get active() {
    return this.timer.state === 'running';
  }

  setProfile(id) {
    if (this.active) return false;
    this.profile = this.getProfile(id);
    this.reset();
    return true;
  }

  reset(notice = '') {
    this.phase = 'focus';
    this.notice = notice;
    this.timer.reset(this.profile.focusMinutes * 60_000);
  }

  beginBreak(startedAt) {
    this.phase = 'break';
    this.notice = '';
    this.breakSerial++;
    this.timer.reset(this.profile.breakMinutes * 60_000);
    this.timer.start(startedAt);
    // A delayed update still starts the break at the scheduled end of focus.
    if (this.timer.update()) {
      this.reset('Break finished');
      return 'cycle-ended';
    }
    return 'break-started';
  }

  advanceAfterEnd(endedAt) {
    if (this.phase === 'focus') return this.beginBreak(endedAt);
    this.reset('Break finished');
    return 'cycle-ended';
  }

  update() {
    const endedAt = this.timer.deadline;
    if (!this.timer.update()) return null;
    return this.advanceAfterEnd(endedAt);
  }

  start() {
    // Play only starts an idle focus session; it never interrupts a running phase.
    if (this.active || this.phase !== 'focus' || this.timer.state !== 'ready') return false;
    this.notice = '';
    return this.timer.start();
  }
}

if (typeof module !== 'undefined') module.exports = { FocusCycle, FOCUS_PROFILES };
