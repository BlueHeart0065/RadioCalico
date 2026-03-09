class NowPlaying {
  constructor({ npTitle, npArtist, HlsEvents }) {
    this._npTitle   = npTitle;
    this._npArtist  = npArtist;
    this._HlsEvents = HlsEvents;
    this._hls       = null;
    this._audio     = null;
    this._hlsHandlers = {};
  }

  attach(hls, audio) {
    this._hls   = hls;
    this._audio = audio;

    // Source 1: FRAG_CHANGED — EXTINF title field (text after the comma)
    const onFragChanged = (_e, data) => {
      const tags = data?.frag?.tagList;
      if (!tags) return;
      for (const [key, val] of tags) {
        if (key === 'INF' && val) { this._update(val); return; }
      }
    };

    // Source 2: FRAG_PARSING_METADATA — ID3 timed metadata in segments
    const onFragParsingMetadata = (_e, data) => {
      const samples = data?.samples;
      if (!samples?.length) return;
      let title = null, artist = null;
      for (const sample of samples) {
        for (const frame of (sample.data || [])) {
          if (frame.key === 'TIT2') title  = frame.info || frame.data;
          if (frame.key === 'TPE1') artist = frame.info || frame.data;
        }
      }
      if (title || artist) {
        const raw = artist ? `${artist} - ${title ?? ''}` : title;
        this._update(raw);
      }
    };

    this._hlsHandlers = {
      [this._HlsEvents.FRAG_CHANGED]:          onFragChanged,
      [this._HlsEvents.FRAG_PARSING_METADATA]: onFragParsingMetadata,
    };
    for (const [event, handler] of Object.entries(this._hlsHandlers)) {
      hls.on(event, handler);
    }

    // Source 3: browser TextTrack API (ID3 metadata track created by hls.js / native HLS)
    this._setupTextTrack(audio);
  }

  detach() {
    if (this._hls) {
      for (const [event, handler] of Object.entries(this._hlsHandlers)) {
        this._hls.off(event, handler);
      }
    }
    this._hlsHandlers = {};
    this._hls  = null;
    this._audio = null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _setupTextTrack(audio) {
    const tryTrack = (track) => {
      if (track.kind !== 'metadata') return;
      track.mode = 'hidden';
      track.addEventListener('cuechange', () => {
        for (const cue of (track.activeCues || [])) {
          const v = cue.value;
          if (!v) continue;
          if (v.key === 'TIT2') this._npTitle.textContent  = v.info || v.data || '—';
          if (v.key === 'TPE1') this._npArtist.textContent = v.info || v.data || 'Live Radio';
        }
      });
    };

    for (const track of (audio.textTracks || [])) tryTrack(track);
    audio.textTracks?.addEventListener?.('addtrack', (e) => tryTrack(e.track));
  }

  _parse(raw) {
    if (!raw) return { title: '—', artist: 'Live Radio' };
    const dash = raw.indexOf(' - ');
    if (dash !== -1) {
      return { artist: raw.slice(0, dash).trim(), title: raw.slice(dash + 3).trim() };
    }
    return { title: raw.trim(), artist: 'Live Radio' };
  }

  _update(raw) {
    const { title, artist } = this._parse(raw);
    this._npTitle.textContent  = title;
    this._npArtist.textContent = artist;
    if (typeof document !== 'undefined') {
      document.title = `${title} — RadioCalico`;
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NowPlaying };
}
