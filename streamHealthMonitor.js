// streamHealthMonitor.js – HLS stream health monitoring and auto-recovery
// Works in both browser (loaded via <script>) and Node.js (via require()).

class StreamHealthMonitor {
  /**
   * @param {object}   deps
   * @param {object}   deps.audio          – HTMLAudioElement (or mock)
   * @param {object}   deps.HlsEvents      – Hls.Events object (injected for testability)
   * @param {Function} deps.onStatusChange – (state, details?) => void
   * @param {Function} deps.onLog          – (msg) => void
   * @param {Function} deps.onRestart      – () => void
   */
  constructor(deps) {
    this.audio          = deps.audio;
    this.HlsEvents      = deps.HlsEvents;
    this.onStatusChange = deps.onStatusChange || (() => {});
    this.onLog          = deps.onLog          || (() => {});
    this.onRestart      = deps.onRestart      || (() => {});

    // Private fields
    this._hls             = null;
    this._hlsHandlers     = {};
    this._audioHandlers   = {};
    this._intervalId      = null;
    this._retryTimeout    = null;
    this._lastPlaybackTime = null;
    this._frozenSeconds   = 0;
    this._retryIndex      = 0;
    this._awaitingRecovery = false;
    this._status          = 'CONNECTING';
  }

  // ── Constants ────────────────────────────────────────────────────────────────

  static get RETRY_DELAYS()         { return [3000, 6000, 12000, 24000, 30000]; }
  static get MAX_RETRIES()          { return 10; }
  static get TICK_MS()              { return 5000; }
  static get FREEZE_THRESHOLD_S()   { return 10; }
  static get BUFFER_WARNING_S()     { return 3; }
  static get BUFFER_CRITICAL_S()    { return 1; }

  // ── Public API ───────────────────────────────────────────────────────────────

  attach(hls) {
    this._hls = hls;

    // HLS event handlers
    const onManifestParsed = (_e, _data) => {
      if (!this._hls) return;
      if (this._status === 'CONNECTING' || this._status === 'RECONNECTING') {
        this._resetRetryCounter();
        this._setState('LIVE');
      }
    };

    const onError = (_e, data) => {
      if (!this._hls) return;
      if (data.fatal) {
        this._handleFatalError(data);
      } else {
        this.onLog('[StreamHealth] Non-fatal HLS error: ' + (data.details || 'unknown'));
      }
    };

    const onFragLoading = (_e, data) => {
      if (!this._hls) return;
      this.onLog('[StreamHealth] Loading frag sn=' + (data?.frag?.sn ?? '?'));
    };

    const onFragLoaded = (_e, data) => {
      if (!this._hls) return;
      this.onLog('[StreamHealth] Loaded frag sn=' + (data?.frag?.sn ?? '?'));
    };

    const onBufferAppended = (_e, _data) => {
      if (!this._hls) return;
      this.onLog('[StreamHealth] Buffer appended');
    };

    this._hlsHandlers = {
      [this.HlsEvents.MANIFEST_PARSED]:  onManifestParsed,
      [this.HlsEvents.ERROR]:            onError,
      [this.HlsEvents.FRAG_LOADING]:     onFragLoading,
      [this.HlsEvents.FRAG_LOADED]:      onFragLoaded,
      [this.HlsEvents.BUFFER_APPENDED]:  onBufferAppended,
    };

    for (const [event, handler] of Object.entries(this._hlsHandlers)) {
      hls.on(event, handler);
    }

    // Audio event handlers
    const onWaiting = () => {
      if (!this._hls) return;
      if (this._status === 'LIVE' || this._status === 'CONNECTING') {
        this._setState('BUFFERING');
      }
    };

    const onPlaying = () => {
      if (!this._hls) return;
      if (this._status === 'BUFFERING' || this._status === 'RECONNECTING') {
        this._resetRetryCounter();
        this._lastPlaybackTime = this.audio.currentTime;
        this._frozenSeconds = 0;
        this._setState('LIVE');
      }
    };

    const onStalled = () => {
      if (!this._hls) return;
      this.onLog('[StreamHealth] Audio stalled event (freeze detection active)');
    };

    this._audioHandlers = {
      waiting: onWaiting,
      playing: onPlaying,
      stalled: onStalled,
    };

    for (const [event, handler] of Object.entries(this._audioHandlers)) {
      this.audio.addEventListener(event, handler);
    }

    // Start health check interval
    this._intervalId = setInterval(() => this._tick(), StreamHealthMonitor.TICK_MS);
  }

  detach() {
    clearInterval(this._intervalId);
    this._intervalId = null;

    clearTimeout(this._retryTimeout);
    this._retryTimeout = null;

    if (this._hls) {
      for (const [event, handler] of Object.entries(this._hlsHandlers)) {
        this._hls.off(event, handler);
      }
    }
    this._hlsHandlers = {};
    this._hls = null;

    for (const [event, handler] of Object.entries(this._audioHandlers)) {
      this.audio.removeEventListener(event, handler);
    }
    this._audioHandlers = {};

    this._lastPlaybackTime = null;
    this._frozenSeconds = 0;
    this._awaitingRecovery = false;
  }

  getStreamStatus() {
    return this._status;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  _setState(newState, details) {
    if (this._status === newState) return;
    this._status = newState;
    this.onStatusChange(newState, details);
  }

  _resetRetryCounter() {
    this._retryIndex = 0;
  }

  _tick() {
    this._checkFreeze();
    this._checkBuffer();
  }

  _checkFreeze() {
    const s = this._status;
    if (this.audio.paused || s === 'RECONNECTING' || s === 'OFFLINE' || s === 'CONNECTING') return;

    const now = this.audio.currentTime;
    if (now > this._lastPlaybackTime) {
      this._lastPlaybackTime = now;
      this._frozenSeconds = 0;
    } else {
      this._frozenSeconds += StreamHealthMonitor.TICK_MS / 1000;
    }

    if (this._frozenSeconds >= StreamHealthMonitor.FREEZE_THRESHOLD_S) {
      this.onLog('[StreamHealth] Freeze detected (' + this._frozenSeconds + 's), stalling stream');
      this._setState('STALLED');
      this._scheduleRestart();
    }
  }

  _checkBuffer() {
    const s = this._status;
    if (s === 'RECONNECTING' || s === 'OFFLINE' || s === 'CONNECTING') return;

    const bufLen = this._getBufferLength();
    if (bufLen === null) return;

    if (bufLen < StreamHealthMonitor.BUFFER_CRITICAL_S && s !== 'STALLED') {
      this.onLog('[StreamHealth] Buffer critical (' + bufLen.toFixed(2) + 's), stalling stream');
      this._setState('STALLED');
      this._scheduleRestart();
    } else if (bufLen < StreamHealthMonitor.BUFFER_WARNING_S && s === 'LIVE') {
      this.onLog('[StreamHealth] Buffer low (' + bufLen.toFixed(2) + 's)');
      this._setState('BUFFERING');
    }
  }

  _getBufferLength() {
    try {
      const b = this.audio.buffered;
      if (!b || b.length === 0) return null;
      return b.end(0) - this.audio.currentTime;
    } catch (_) {
      return null;
    }
  }

  _scheduleRestart() {
    if (this._status === 'OFFLINE') return;
    if (this._retryTimeout !== null) return;

    if (this._retryIndex >= StreamHealthMonitor.MAX_RETRIES) {
      this._setState('OFFLINE');
      return;
    }

    const delays = StreamHealthMonitor.RETRY_DELAYS;
    const delay = delays[Math.min(this._retryIndex, delays.length - 1)];
    this._retryIndex++;

    this._setState('RECONNECTING', { attempt: this._retryIndex });
    this.onLog('[StreamHealth] Attempting reconnect (retry ' + this._retryIndex + ') in ' + delay + 'ms');

    this._retryTimeout = setTimeout(() => {
      this._retryTimeout = null;
      this.onRestart();
    }, delay);
  }

  _handleFatalError(data) {
    if (this._awaitingRecovery) {
      this._awaitingRecovery = false;
      this._scheduleRestart();
      return;
    }

    if (data.type === 'mediaError') {
      this._awaitingRecovery = true;
      this._hls.recoverMediaError();
    } else {
      this._setState('STALLED');
      this._scheduleRestart();
    }
  }
}

// CommonJS export for Jest; no-op in browser (StreamHealthMonitor becomes a global)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StreamHealthMonitor };
}
