// tests/stream-management.test.js
// Unit tests for StreamManager – destroy() and load() and metadata helpers.
// All browser globals (Hls, Audio, DOM nodes) are mocked; no browser needed.

'use strict';

const { StreamManager } = require('../client/js/stream-manager');

// ── Mock Hls ──────────────────────────────────────────────────────────────────
class MockHls {
  constructor(opts) {
    this.opts       = opts;
    this.destroyed  = false;
    this.loadedUrl  = null;
    this.attachedMedia = null;
    this._handlers  = {};
    this.levels     = [];
    this.currentLevel = 0;
    MockHls.instances.push(this);
  }

  static isSupported() { return true; }

  static get Events() {
    return {
      MANIFEST_PARSED: 'manifestparsed',
      FRAG_CHANGED:    'fragchanged',
      LEVEL_LOADED:    'levelloaded',
      ERROR:           'hlserror',
    };
  }

  loadSource(url)     { this.loadedUrl      = url; }
  attachMedia(audio)  { this.attachedMedia  = audio; }
  on(event, cb)       { this._handlers[event] = cb; }
  destroy()           { this.destroyed = true; }

  // Test helper – fire an event manually
  trigger(event, data = {}) {
    this._handlers[event]?.(event, data);
  }
}

MockHls.instances = [];

// ── Mock Audio element ────────────────────────────────────────────────────────
class MockAudio {
  constructor() {
    this.src      = '';
    this.volume   = 1;
    this._paused  = false;
    this._listeners = {};
  }
  pause()               { this._paused = true; }
  play()                { return Promise.resolve(); }
  canPlayType()         { return ''; }
  addEventListener(ev, cb, opts) {
    this._listeners[ev] = cb;
    if (opts?.once) {
      const orig = this._listeners[ev];
      this._listeners[ev] = (...args) => { orig(...args); delete this._listeners[ev]; };
    }
  }
  // Test helper
  triggerEvent(ev)      { this._listeners[ev]?.(); }
}

// ── Factory helper ────────────────────────────────────────────────────────────
function makeManager(overrides = {}) {
  const mockAudio   = new MockAudio();
  const mockPlayBtn = { disabled: false };
  const mockCatIcon = { classList: { add: jest.fn(), remove: jest.fn() } };
  const mockNpTitle  = { textContent: '' };
  const mockNpArtist = { textContent: '' };
  const onStatus       = jest.fn();
  const onShowIcon     = jest.fn();
  const onQualityBadge = jest.fn();
  const onDestroy      = jest.fn();

  const manager = new StreamManager({
    audio:          mockAudio,
    Hls:            MockHls,
    playBtn:        mockPlayBtn,
    catIcon:        mockCatIcon,
    npTitle:        mockNpTitle,
    npArtist:       mockNpArtist,
    onStatus,
    onShowIcon,
    onQualityBadge,
    onDestroy,
    ...overrides,
  });

  return { manager, mockAudio, mockPlayBtn, mockCatIcon, mockNpTitle, mockNpArtist,
           onStatus, onShowIcon, onQualityBadge, onDestroy };
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockHls.instances = [];
});

// ══════════════════════════════════════════════════════════════════════════════
describe('destroy()', () => {

  it('destroys the hls instance and nulls the reference', () => {
    const { manager } = makeManager();
    manager.load('https://example.com/live.m3u8');
    const hlsInstance = MockHls.instances[0];

    manager.destroy();

    expect(hlsInstance.destroyed).toBe(true);
    expect(manager.hls).toBeNull();
  });

  it('clears audio.src', () => {
    const { manager, mockAudio } = makeManager();
    mockAudio.src = 'https://example.com/live.m3u8';

    manager.destroy();

    expect(mockAudio.src).toBe('');
  });

  it('resets playing flag to false', () => {
    const { manager } = makeManager();
    manager.playing = true;

    manager.destroy();

    expect(manager.playing).toBe(false);
  });

  it('calls onShowIcon("play")', () => {
    const { manager, onShowIcon } = makeManager();

    manager.destroy();

    expect(onShowIcon).toHaveBeenCalledWith('play');
  });

  it('removes "hidden" class from catIcon', () => {
    const { manager, mockCatIcon } = makeManager();

    manager.destroy();

    expect(mockCatIcon.classList.remove).toHaveBeenCalledWith('hidden');
  });

  it('calls onDestroy hook (for visualizer teardown)', () => {
    const { manager, onDestroy } = makeManager();

    manager.destroy();

    expect(onDestroy).toHaveBeenCalled();
  });

  it('does not throw when hls is already null', () => {
    const { manager } = makeManager();

    expect(() => manager.destroy()).not.toThrow();
  });

  it('is safe to call multiple times', () => {
    const { manager } = makeManager();

    expect(() => {
      manager.destroy();
      manager.destroy();
    }).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('load(url)', () => {

  it('calls destroy() before initialising the new stream', () => {
    const { manager } = makeManager();
    const spy = jest.spyOn(manager, 'destroy');

    manager.load('https://example.com/live.m3u8');

    expect(spy).toHaveBeenCalled();
  });

  it('shows loading spinner immediately', () => {
    const { manager, onShowIcon } = makeManager();

    manager.load('https://example.com/live.m3u8');

    expect(onShowIcon).toHaveBeenCalledWith('loading');
  });

  it('disables the play button during load', () => {
    const { manager, mockPlayBtn } = makeManager();

    manager.load('https://example.com/live.m3u8');

    expect(mockPlayBtn.disabled).toBe(true);
  });

  it('sets npTitle to "—" and npArtist to "Connecting…"', () => {
    const { manager, mockNpTitle, mockNpArtist } = makeManager();

    manager.load('https://example.com/live.m3u8');

    expect(mockNpTitle.textContent).toBe('—');
    expect(mockNpArtist.textContent).toBe('Connecting…');
  });

  it('creates exactly one Hls instance', () => {
    const { manager } = makeManager();

    manager.load('https://example.com/live.m3u8');

    expect(MockHls.instances).toHaveLength(1);
  });

  it('calls hls.loadSource with the provided URL', () => {
    const url = 'https://example.com/live.m3u8';
    const { manager } = makeManager();

    manager.load(url);

    expect(MockHls.instances[0].loadedUrl).toBe(url);
  });

  it('attaches the audio element to the Hls instance', () => {
    const { manager, mockAudio } = makeManager();

    manager.load('https://example.com/live.m3u8');

    expect(MockHls.instances[0].attachedMedia).toBe(mockAudio);
  });

  // ── MANIFEST_PARSED ──
  it('enables play button and shows play icon when manifest is parsed', () => {
    const { manager, mockPlayBtn, onShowIcon } = makeManager();

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.MANIFEST_PARSED);

    expect(mockPlayBtn.disabled).toBe(false);
    expect(onShowIcon).toHaveBeenCalledWith('play');
  });

  it('sets status to "Stream ready" on MANIFEST_PARSED', () => {
    const { manager, onStatus } = makeManager();

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.MANIFEST_PARSED);

    expect(onStatus).toHaveBeenCalledWith('Stream ready — click play', 'ok');
  });

  it('sets npArtist to "Live Radio" on MANIFEST_PARSED when still "Connecting…"', () => {
    const { manager, mockNpArtist } = makeManager();

    manager.load('https://example.com/live.m3u8');
    expect(mockNpArtist.textContent).toBe('Connecting…');
    MockHls.instances[0].trigger(MockHls.Events.MANIFEST_PARSED);

    expect(mockNpArtist.textContent).toBe('Live Radio');
  });

  // ── LEVEL_LOADED codec detection ──
  it('reports FLAC codec via onQualityBadge on LEVEL_LOADED', () => {
    const { manager, onQualityBadge } = makeManager();

    manager.load('https://example.com/live.m3u8');
    const hls = MockHls.instances[0];
    hls.levels = [{ audioCodec: 'flac' }];
    hls.currentLevel = 0;
    hls.trigger(MockHls.Events.LEVEL_LOADED);

    expect(onQualityBadge).toHaveBeenCalledWith('FLAC · Lossless · HLS');
  });

  it('reports ALAC codec via onQualityBadge on LEVEL_LOADED', () => {
    const { manager, onQualityBadge } = makeManager();

    manager.load('https://example.com/live.m3u8');
    const hls = MockHls.instances[0];
    hls.levels = [{ audioCodec: 'alac' }];
    hls.currentLevel = 0;
    hls.trigger(MockHls.Events.LEVEL_LOADED);

    expect(onQualityBadge).toHaveBeenCalledWith('ALAC · Lossless · HLS');
  });

  it('uppercases unknown codec names', () => {
    const { manager, onQualityBadge } = makeManager();

    manager.load('https://example.com/live.m3u8');
    const hls = MockHls.instances[0];
    hls.levels = [{ audioCodec: 'mp4a.40.2' }];
    hls.currentLevel = 0;
    hls.trigger(MockHls.Events.LEVEL_LOADED);

    expect(onQualityBadge).toHaveBeenCalledWith('MP4A.40.2 · HLS');
  });

  it('does nothing on LEVEL_LOADED when no audioCodec field', () => {
    const { manager, onQualityBadge } = makeManager();

    manager.load('https://example.com/live.m3u8');
    const hls = MockHls.instances[0];
    hls.levels = [{}];
    hls.currentLevel = 0;
    hls.trigger(MockHls.Events.LEVEL_LOADED);

    expect(onQualityBadge).not.toHaveBeenCalled();
  });

  // ── ERROR ──
  it('shows error status on a fatal HLS error', () => {
    const { manager, onStatus } = makeManager();

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.ERROR, { fatal: true, details: 'networkError' });

    expect(onStatus).toHaveBeenCalledWith(
      expect.stringContaining('networkError'), 'error'
    );
  });

  it('re-enables play button after a fatal error', () => {
    const { manager, mockPlayBtn } = makeManager();

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.ERROR, { fatal: true, details: 'networkError' });

    expect(mockPlayBtn.disabled).toBe(false);
  });

  it('resets playing flag after a fatal error', () => {
    const { manager } = makeManager();
    manager.playing = true;

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.ERROR, { fatal: true, details: 'networkError' });

    expect(manager.playing).toBe(false);
  });

  it('ignores non-fatal HLS errors', () => {
    const { manager, mockPlayBtn } = makeManager();
    mockPlayBtn.disabled = true;

    manager.load('https://example.com/live.m3u8');
    MockHls.instances[0].trigger(MockHls.Events.ERROR, { fatal: false, details: 'bufferAppendingError' });

    // play button remains disabled (manifest not yet parsed)
    expect(mockPlayBtn.disabled).toBe(true);
  });

  // ── Native HLS fallback (Safari) ──
  it('falls back to native HLS when Hls.isSupported() is false', () => {
    class UnsupportedHls { static isSupported() { return false; } }
    const mockAudio   = new MockAudio();
    mockAudio.canPlayType = () => 'maybe';
    const mockPlayBtn = { disabled: false };

    const manager = new StreamManager({
      audio:          mockAudio,
      Hls:            UnsupportedHls,
      playBtn:        mockPlayBtn,
      catIcon:        { classList: { add: jest.fn(), remove: jest.fn() } },
      npTitle:        { textContent: '' },
      npArtist:       { textContent: '' },
      onStatus:       jest.fn(),
      onShowIcon:     jest.fn(),
      onQualityBadge: jest.fn(),
      onDestroy:      jest.fn(),
    });

    const url = 'https://example.com/live.m3u8';
    manager.load(url);

    expect(mockAudio.src).toBe(url);
  });

  it('enables play button on loadedmetadata in Safari fallback', () => {
    class UnsupportedHls { static isSupported() { return false; } }
    const mockAudio   = new MockAudio();
    mockAudio.canPlayType = () => 'maybe';
    const mockPlayBtn = { disabled: true };

    const manager = new StreamManager({
      audio:          mockAudio,
      Hls:            UnsupportedHls,
      playBtn:        mockPlayBtn,
      catIcon:        { classList: { add: jest.fn(), remove: jest.fn() } },
      npTitle:        { textContent: '' },
      npArtist:       { textContent: '' },
      onStatus:       jest.fn(),
      onShowIcon:     jest.fn(),
      onQualityBadge: jest.fn(),
      onDestroy:      jest.fn(),
    });

    manager.load('https://example.com/live.m3u8');
    mockAudio.triggerEvent('loadedmetadata');

    expect(mockPlayBtn.disabled).toBe(false);
  });

  // ── Unsupported ──
  it('shows unsupported error when neither HLS.js nor native HLS works', () => {
    class UnsupportedHls { static isSupported() { return false; } }
    const mockAudio   = new MockAudio();
    mockAudio.canPlayType = () => '';    // no native HLS support either
    const onStatus    = jest.fn();
    const mockPlayBtn = { disabled: true };

    const manager = new StreamManager({
      audio:          mockAudio,
      Hls:            UnsupportedHls,
      playBtn:        mockPlayBtn,
      catIcon:        { classList: { add: jest.fn(), remove: jest.fn() } },
      npTitle:        { textContent: '' },
      npArtist:       { textContent: '' },
      onStatus,
      onShowIcon:     jest.fn(),
      onQualityBadge: jest.fn(),
      onDestroy:      jest.fn(),
    });

    manager.load('https://example.com/live.m3u8');

    expect(onStatus).toHaveBeenCalledWith(
      expect.stringContaining('not supported'), 'error'
    );
    expect(mockPlayBtn.disabled).toBe(false);
  });
});

