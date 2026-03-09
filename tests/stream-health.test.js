// tests/stream-health.test.js
// Unit tests for StreamHealthMonitor – auto-recovery, state machine, backoff.

'use strict';

const { StreamHealthMonitor } = require('../streamHealthMonitor');

// ── Mock Hls ──────────────────────────────────────────────────────────────────
class MockHls {
  constructor() {
    this._handlers    = {};
    this._recovered   = false;
    MockHls.instances.push(this);
  }

  static get Events() {
    return {
      MANIFEST_PARSED:  'manifestparsed',
      FRAG_CHANGED:     'fragchanged',
      FRAG_LOADING:     'fragloading',
      FRAG_LOADED:      'fragloaded',
      BUFFER_APPENDED:  'bufferappended',
      LEVEL_LOADED:     'levelloaded',
      ERROR:            'hlserror',
    };
  }

  on(event, cb) {
    if (!this._handlers[event]) this._handlers[event] = [];
    this._handlers[event].push(cb);
  }

  off(event, cb) {
    if (!this._handlers[event]) return;
    this._handlers[event] = this._handlers[event].filter(fn => fn !== cb);
  }

  trigger(event, data = {}) {
    (this._handlers[event] || []).forEach(fn => fn(event, data));
  }

  recoverMediaError() {
    this._recovered = true;
  }
}

MockHls.instances = [];

// ── Mock Audio element ────────────────────────────────────────────────────────
class MockAudio {
  constructor() {
    this.currentTime = 0;
    this.paused      = false;
    this.buffered    = { length: 0 };
    this._listeners  = {};
  }

  addEventListener(ev, cb) {
    if (!this._listeners[ev]) this._listeners[ev] = [];
    this._listeners[ev].push(cb);
  }

  removeEventListener(ev, cb) {
    if (!this._listeners[ev]) return;
    this._listeners[ev] = this._listeners[ev].filter(fn => fn !== cb);
  }

  trigger(ev) {
    (this._listeners[ev] || []).forEach(fn => fn());
  }
}

// ── Factory helpers ───────────────────────────────────────────────────────────
function makeMonitor(overrides = {}) {
  const mockAudio      = new MockAudio();
  const onStatusChange = jest.fn();
  const onLog          = jest.fn();
  const onRestart      = jest.fn();

  const monitor = new StreamHealthMonitor({
    audio:          mockAudio,
    HlsEvents:      MockHls.Events,
    onStatusChange,
    onLog,
    onRestart,
    ...overrides,
  });

  return { monitor, mockAudio, onStatusChange, onLog, onRestart };
}

function makeAttachedMonitor(overrides = {}) {
  const result   = makeMonitor(overrides);
  const mockHls  = new MockHls();
  result.monitor.attach(mockHls);
  return { ...result, mockHls };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockHls.instances = [];
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

// ══════════════════════════════════════════════════════════════════════════════
describe('constructor', () => {
  it('sets initial status to CONNECTING', () => {
    const { monitor } = makeMonitor();
    expect(monitor.getStreamStatus()).toBe('CONNECTING');
  });

  it('initialises _retryIndex to 0', () => {
    const { monitor } = makeMonitor();
    expect(monitor._retryIndex).toBe(0);
  });

  it('initialises _hls to null', () => {
    const { monitor } = makeMonitor();
    expect(monitor._hls).toBeNull();
  });

  it('defaults missing callbacks to no-ops', () => {
    const monitor = new StreamHealthMonitor({
      audio:     new MockAudio(),
      HlsEvents: MockHls.Events,
    });
    expect(() => monitor.onStatusChange('LIVE')).not.toThrow();
    expect(() => monitor.onLog('test')).not.toThrow();
    expect(() => monitor.onRestart()).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('attach / detach', () => {
  it('sets _hls on attach', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    expect(monitor._hls).toBe(mockHls);
  });

  it('registers handlers on the hls instance', () => {
    const { mockHls } = makeAttachedMonitor();
    expect(mockHls._handlers[MockHls.Events.MANIFEST_PARSED]).toHaveLength(1);
    expect(mockHls._handlers[MockHls.Events.ERROR]).toHaveLength(1);
  });

  it('registers audio event handlers', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    expect(mockAudio._listeners['waiting']).toHaveLength(1);
    expect(mockAudio._listeners['playing']).toHaveLength(1);
    expect(mockAudio._listeners['stalled']).toHaveLength(1);
  });

  it('starts the interval timer on attach', () => {
    const { monitor } = makeAttachedMonitor();
    expect(monitor._intervalId).not.toBeNull();
  });

  it('nulls _hls on detach', () => {
    const { monitor } = makeAttachedMonitor();
    monitor.detach();
    expect(monitor._hls).toBeNull();
  });

  it('clears the interval on detach', () => {
    const { monitor } = makeAttachedMonitor();
    monitor.detach();
    expect(monitor._intervalId).toBeNull();
  });

  it('removes audio listeners on detach', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor.detach();
    expect((mockAudio._listeners['waiting'] || []).length).toBe(0);
    expect((mockAudio._listeners['playing'] || []).length).toBe(0);
    expect((mockAudio._listeners['stalled'] || []).length).toBe(0);
  });

  it('removes hls listeners on detach', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    monitor.detach();
    expect((mockHls._handlers[MockHls.Events.MANIFEST_PARSED] || []).length).toBe(0);
    expect((mockHls._handlers[MockHls.Events.ERROR] || []).length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('getStreamStatus()', () => {
  it('returns the current status string', () => {
    const { monitor } = makeMonitor();
    expect(monitor.getStreamStatus()).toBe('CONNECTING');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('MANIFEST_PARSED', () => {
  it('transitions CONNECTING → LIVE', () => {
    const { monitor, mockHls, onStatusChange } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.MANIFEST_PARSED);
    expect(monitor.getStreamStatus()).toBe('LIVE');
    expect(onStatusChange).toHaveBeenCalledWith('LIVE', undefined);
  });

  it('transitions RECONNECTING → LIVE', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    monitor._status = 'RECONNECTING';
    mockHls.trigger(MockHls.Events.MANIFEST_PARSED);
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });

  it('resets the retry counter on MANIFEST_PARSED', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    monitor._retryIndex = 5;
    mockHls.trigger(MockHls.Events.MANIFEST_PARSED);
    expect(monitor._retryIndex).toBe(0);
  });

  it('does not change state when already LIVE', () => {
    const { monitor, mockHls, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    onStatusChange.mockClear();
    mockHls.trigger(MockHls.Events.MANIFEST_PARSED);
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('HLS ERROR — fatal', () => {
  it('calls recoverMediaError() on mediaError type', () => {
    const { mockHls } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.ERROR, { fatal: true, type: 'mediaError' });
    expect(mockHls._recovered).toBe(true);
  });

  it('sets _awaitingRecovery=true after recoverMediaError()', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.ERROR, { fatal: true, type: 'mediaError' });
    expect(monitor._awaitingRecovery).toBe(true);
  });

  it('schedules restart on non-mediaError fatal', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockHls.trigger(MockHls.Events.ERROR, { fatal: true, type: 'networkError' });
    expect(monitor.getStreamStatus()).toBe('RECONNECTING');
  });

  it('schedules restart when recovery itself fails (double fatal)', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    // First error: media error → attempt recovery
    mockHls.trigger(MockHls.Events.ERROR, { fatal: true, type: 'mediaError' });
    expect(monitor._awaitingRecovery).toBe(true);
    // Second error: recovery failed
    mockHls.trigger(MockHls.Events.ERROR, { fatal: true, type: 'mediaError' });
    expect(monitor._awaitingRecovery).toBe(false);
    expect(monitor.getStreamStatus()).toBe('RECONNECTING');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('HLS ERROR — non-fatal', () => {
  it('logs but does not change state', () => {
    const { monitor, mockHls, onStatusChange, onLog } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    onStatusChange.mockClear();
    mockHls.trigger(MockHls.Events.ERROR, { fatal: false, details: 'bufferAppendingError' });
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalled();
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('FRAG_LOADING / FRAG_LOADED / BUFFER_APPENDED', () => {
  it('logs on FRAG_LOADING', () => {
    const { mockHls, onLog } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.FRAG_LOADING, { frag: { sn: 42 } });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('42'));
  });

  it('logs on FRAG_LOADED', () => {
    const { mockHls, onLog } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.FRAG_LOADED, { frag: { sn: 7 } });
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('7'));
  });

  it('logs on BUFFER_APPENDED', () => {
    const { mockHls, onLog } = makeAttachedMonitor();
    mockHls.trigger(MockHls.Events.BUFFER_APPENDED);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('Buffer appended'));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('audio: waiting', () => {
  it('transitions LIVE → BUFFERING', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockAudio.trigger('waiting');
    expect(monitor.getStreamStatus()).toBe('BUFFERING');
  });

  it('transitions CONNECTING → BUFFERING', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    mockAudio.trigger('waiting');
    expect(monitor.getStreamStatus()).toBe('BUFFERING');
  });

  it('does not change state from STALLED', () => {
    const { monitor, mockAudio, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    onStatusChange.mockClear();
    mockAudio.trigger('waiting');
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('audio: playing', () => {
  it('transitions BUFFERING → LIVE', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'BUFFERING';
    mockAudio.trigger('playing');
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });

  it('transitions RECONNECTING → LIVE', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'RECONNECTING';
    mockAudio.trigger('playing');
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });

  it('resets retry counter on playing', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'BUFFERING';
    monitor._retryIndex = 3;
    mockAudio.trigger('playing');
    expect(monitor._retryIndex).toBe(0);
  });

  it('resets freeze baseline on playing', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'BUFFERING';
    monitor._frozenSeconds = 8;
    mockAudio.currentTime = 42;
    mockAudio.trigger('playing');
    expect(monitor._frozenSeconds).toBe(0);
    expect(monitor._lastPlaybackTime).toBe(42);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('audio: stalled', () => {
  it('logs only, does not change state', () => {
    const { monitor, mockAudio, onStatusChange, onLog } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    onStatusChange.mockClear();
    mockAudio.trigger('stalled');
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(onLog).toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Freeze detection', () => {
  it('accumulates frozen seconds and triggers STALLED after threshold', () => {
    const { monitor, mockAudio, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    monitor._lastPlaybackTime = 0;
    mockAudio.currentTime = 0;    // time not advancing

    // 2 ticks × 5s = 10s → should stall (then immediately → RECONNECTING)
    jest.advanceTimersByTime(5000);
    jest.advanceTimersByTime(5000);

    // STALLED is emitted before _scheduleRestart() transitions to RECONNECTING
    expect(onStatusChange).toHaveBeenCalledWith('STALLED', undefined);
    expect(['STALLED', 'RECONNECTING']).toContain(monitor.getStreamStatus());
  });

  it('resets frozen counter when time advances', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    monitor._lastPlaybackTime = 0;
    mockAudio.currentTime = 0;

    jest.advanceTimersByTime(5000);
    expect(monitor._frozenSeconds).toBe(5);

    // Time advances — counter should reset
    mockAudio.currentTime = 5;
    jest.advanceTimersByTime(5000);
    expect(monitor._frozenSeconds).toBe(0);
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });

  it('skips freeze check when audio is paused', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    monitor._lastPlaybackTime = 0;
    mockAudio.currentTime = 0;
    mockAudio.paused = true;

    jest.advanceTimersByTime(10000);

    expect(monitor.getStreamStatus()).toBe('LIVE');
    expect(monitor._frozenSeconds).toBe(0);
  });

  it('skips freeze check in RECONNECTING state', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'RECONNECTING';
    monitor._lastPlaybackTime = 0;
    mockAudio.currentTime = 0;

    jest.advanceTimersByTime(10000);

    expect(monitor.getStreamStatus()).toBe('RECONNECTING');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Buffer health', () => {
  it('returns null and skips when buffered.length is 0', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockAudio.buffered = { length: 0 };

    jest.advanceTimersByTime(5000);

    // No state change (null → skip)
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });

  it('logs warning and transitions to BUFFERING when buffer < 3s', () => {
    const { monitor, mockAudio, onLog } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockAudio.currentTime = 10;
    mockAudio.buffered = { length: 1, end: () => 12 };  // 2s buffer

    jest.advanceTimersByTime(5000);

    expect(monitor.getStreamStatus()).toBe('BUFFERING');
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('Buffer low'));
  });

  it('logs critical and transitions to STALLED when buffer < 1s', () => {
    const { monitor, mockAudio, onLog, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockAudio.currentTime = 10;
    mockAudio.buffered = { length: 1, end: () => 10.5 };  // 0.5s buffer

    jest.advanceTimersByTime(5000);

    // STALLED is emitted before _scheduleRestart() transitions to RECONNECTING
    expect(onStatusChange).toHaveBeenCalledWith('STALLED', undefined);
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('critical'));
    expect(['STALLED', 'RECONNECTING']).toContain(monitor.getStreamStatus());
  });

  it('does not double-stall when already STALLED', () => {
    const { monitor, mockAudio, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    mockAudio.currentTime = 10;
    mockAudio.buffered = { length: 1, end: () => 10.5 };

    onStatusChange.mockClear();
    jest.advanceTimersByTime(5000);

    // STALLED → RECONNECTING is the only expected call (from _scheduleRestart in prior tick)
    // Since _retryTimeout is null on first call, it will schedule restart
    // But the state change to STALLED should not repeat
    const stalledCalls = onStatusChange.mock.calls.filter(c => c[0] === 'STALLED');
    expect(stalledCalls.length).toBe(0);
  });

  it('skips buffer check in RECONNECTING state', () => {
    const { monitor, mockAudio, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'RECONNECTING';
    monitor._retryTimeout = 'fake'; // prevent further scheduling
    mockAudio.currentTime = 10;
    mockAudio.buffered = { length: 1, end: () => 10.5 };

    onStatusChange.mockClear();
    jest.advanceTimersByTime(5000);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('handles buffered.end() throwing an error gracefully', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    mockAudio.buffered = { length: 1, end: () => { throw new Error('DOM error'); } };

    expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
    expect(monitor.getStreamStatus()).toBe('LIVE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Reconnect backoff', () => {
  it('uses 3s delay for retry #1', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    monitor._scheduleRestart();

    expect(monitor.getStreamStatus()).toBe('RECONNECTING');
    jest.advanceTimersByTime(2999);
    expect(onRestart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('uses 6s delay for retry #2', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._retryIndex = 1;
    monitor._status = 'STALLED';
    monitor._scheduleRestart();

    jest.advanceTimersByTime(5999);
    expect(onRestart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('caps delay at 30s for retry #5+', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._retryIndex = 4;
    monitor._status = 'STALLED';
    monitor._scheduleRestart();

    jest.advanceTimersByTime(29999);
    expect(onRestart).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it('transitions to OFFLINE after MAX_RETRIES', () => {
    const { monitor } = makeAttachedMonitor();
    monitor._retryIndex = StreamHealthMonitor.MAX_RETRIES;
    monitor._status = 'STALLED';
    monitor._scheduleRestart();
    expect(monitor.getStreamStatus()).toBe('OFFLINE');
  });

  it('does not schedule if already OFFLINE', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._status = 'OFFLINE';
    monitor._scheduleRestart();
    jest.advanceTimersByTime(60000);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('re-entry guard prevents double scheduling', () => {
    const { monitor } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    monitor._scheduleRestart();
    const firstTimeout = monitor._retryTimeout;
    monitor._scheduleRestart();
    expect(monitor._retryTimeout).toBe(firstTimeout);
  });

  it('logs the reconnect attempt message', () => {
    const { monitor, onLog } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    monitor._scheduleRestart();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('reconnect'));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('State machine', () => {
  it('_setState is a no-op for same state', () => {
    const { monitor, onStatusChange } = makeAttachedMonitor();
    monitor._status = 'LIVE';
    onStatusChange.mockClear();
    monitor._setState('LIVE');
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('OFFLINE is terminal — _scheduleRestart returns immediately', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._status = 'OFFLINE';
    monitor._scheduleRestart();
    jest.advanceTimersByTime(60000);
    expect(onRestart).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Memory leaks / detach', () => {
  it('clearInterval is called on detach', () => {
    const spy = jest.spyOn(global, 'clearInterval');
    const { monitor } = makeAttachedMonitor();
    const id = monitor._intervalId;
    monitor.detach();
    expect(spy).toHaveBeenCalledWith(id);
    spy.mockRestore();
  });

  it('clearTimeout is called on detach when retry is pending', () => {
    const spy = jest.spyOn(global, 'clearTimeout');
    const { monitor } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    monitor._scheduleRestart();
    const tid = monitor._retryTimeout;
    monitor.detach();
    expect(spy).toHaveBeenCalledWith(tid);
    spy.mockRestore();
  });

  it('hls.off() is called for each registered handler on detach', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    const offSpy = jest.spyOn(mockHls, 'off');
    monitor.detach();
    expect(offSpy).toHaveBeenCalledTimes(
      Object.keys(MockHls.Events).filter(k =>
        ['MANIFEST_PARSED', 'ERROR', 'FRAG_LOADING', 'FRAG_LOADED', 'BUFFER_APPENDED'].includes(k)
      ).length
    );
  });

  it('audio.removeEventListener is called for each handler on detach', () => {
    const { monitor, mockAudio } = makeAttachedMonitor();
    const removeSpy = jest.spyOn(mockAudio, 'removeEventListener');
    monitor.detach();
    expect(removeSpy).toHaveBeenCalledWith('waiting', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('playing', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('stalled', expect.any(Function));
  });

  it('onRestart is not called after detach clears the timeout', () => {
    const { monitor, onRestart } = makeAttachedMonitor();
    monitor._status = 'STALLED';
    monitor._scheduleRestart();
    monitor.detach();
    jest.advanceTimersByTime(60000);
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('guards against stale HLS events firing after detach', () => {
    const { monitor, mockHls } = makeAttachedMonitor();
    // Capture handler before detach
    const handler = mockHls._handlers[MockHls.Events.MANIFEST_PARSED]?.[0];
    monitor.detach();
    // Calling the stale handler directly should be a no-op (guard: if !this._hls return)
    expect(() => handler && handler(MockHls.Events.MANIFEST_PARSED, {})).not.toThrow();
  });
});
