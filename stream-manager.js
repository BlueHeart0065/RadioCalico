// stream-manager.js – stream lifecycle logic, isolated from the DOM
// Works in both browser (loaded via <script>) and Node.js (via require()).

class StreamManager {
  /**
   * @param {object} deps
   * @param {HTMLAudioElement} deps.audio
   * @param {Function}         deps.Hls            – HLS constructor (injected so tests can mock it)
   * @param {object}           deps.playBtn        – { disabled: bool }
   * @param {object}           deps.catIcon        – { classList }
   * @param {object}           deps.npTitle        – { textContent }
   * @param {object}           deps.npArtist       – { textContent }
   * @param {Function}         deps.onStatus       – (msg, type?) => void
   * @param {Function}         deps.onShowIcon     – ('play'|'pause'|'loading') => void
   * @param {Function}         deps.onQualityBadge – (text) => void
   * @param {Function}         deps.onDestroy      – () => void  (visualizer teardown hook)
   */
  constructor(deps) {
    this.audio          = deps.audio;
    this.Hls            = deps.Hls;
    this.playBtn        = deps.playBtn;
    this.catIcon        = deps.catIcon;
    this.npTitle        = deps.npTitle;
    this.npArtist       = deps.npArtist;
    this.onStatus       = deps.onStatus       || (() => {});
    this.onShowIcon     = deps.onShowIcon     || (() => {});
    this.onQualityBadge = deps.onQualityBadge || (() => {});
    this.onDestroy      = deps.onDestroy      || (() => {});

    this.hls     = null;
    this.playing = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  destroy() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
    this.audio.src = '';
    this.playing   = false;
    this.onShowIcon('play');
    this.catIcon.classList.remove('hidden');
    this.onDestroy();
  }

  load(url) {
    this.destroy();
    this.onStatus('Loading stream…');
    this.onShowIcon('loading');
    this.playBtn.disabled     = true;
    this.npTitle.textContent  = '—';
    this.npArtist.textContent = 'Connecting…';

    const Hls = this.Hls;

    if (Hls.isSupported()) {
      this.hls = new Hls({ lowLatencyMode: false });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.audio);

      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        this.onStatus('Stream ready — click play', 'ok');
        this.onShowIcon('play');
        this.playBtn.disabled = false;
        if (this.npArtist.textContent === 'Connecting…') {
          this.npArtist.textContent = 'Live Radio';
        }
      });

      this.hls.on(Hls.Events.LEVEL_LOADED, () => {
        const level = this.hls.levels?.[this.hls.currentLevel];
        if (level?.audioCodec) {
          const codec = level.audioCodec.includes('flac') ? 'FLAC · Lossless'
                      : level.audioCodec.includes('alac') ? 'ALAC · Lossless'
                      : level.audioCodec.toUpperCase();
          this.onQualityBadge(codec + ' · HLS');
        }
      });

      this.hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) {
          this.onStatus('Stream error: ' + (data.details || 'unknown'), 'error');
          this.onShowIcon('play');
          this.playBtn.disabled = false;
          this.playing = false;
        }
      });

    } else if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      this.audio.src = url;
      this.audio.addEventListener('loadedmetadata', () => {
        this.onStatus('Stream ready — click play', 'ok');
        this.onShowIcon('play');
        this.playBtn.disabled = false;
      }, { once: true });

    } else {
      this.onStatus('HLS is not supported in this browser.', 'error');
      this.onShowIcon('play');
      this.playBtn.disabled = false;
    }
  }
}

// CommonJS export for Jest; no-op in browser (StreamManager becomes a global)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StreamManager };
}
