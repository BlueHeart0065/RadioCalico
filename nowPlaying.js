const METADATA_URL  = 'https://d3d4yli4hf5bmh.cloudfront.net/metadatav2.json';
const COVER_URL     = 'https://d3d4yli4hf5bmh.cloudfront.net/cover.jpg';
const POLL_INTERVAL = 10_000; // ms

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

class NowPlaying {
  constructor({ npTitle, npArtist, rpList, albumCover, HlsEvents }) {
    this._npTitle    = npTitle;
    this._npArtist   = npArtist;
    this._rpList     = rpList      || null;
    this._albumCover = albumCover  || null;
    this._HlsEvents  = HlsEvents;
    this._hls        = null;
    this._audio      = null;
    this._hlsHandlers = {};
    this._pollTimer   = null;
  }

  attach(hls, audio) {
    this._hls   = hls;
    this._audio = audio;

    // Source 1: JSON polling — primary source for this stream
    this._startPolling();

    // Source 2: FRAG_CHANGED — EXTINF title field (text after the comma)
    const onFragChanged = (_e, data) => {
      const tags = data?.frag?.tagList;
      if (!tags) return;
      for (const [key, val] of tags) {
        if (key === 'INF' && val) {
          // EXTINF format: "<duration>,<title>" — extract title after the comma
          const commaIdx = val.indexOf(',');
          const title = commaIdx !== -1 ? val.slice(commaIdx + 1).trim() : '';
          if (title) { this._update(title); return; }
        }
      }
    };

    // Source 3: FRAG_PARSING_METADATA — ID3 timed metadata in segments
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

    // Source 4: browser TextTrack API (ID3 metadata track created by hls.js / native HLS)
    this._setupTextTrack(audio);
  }

  detach() {
    this._stopPolling();
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

  _startPolling() {
    this._fetchMeta();
    this._pollTimer = setInterval(() => this._fetchMeta(), POLL_INTERVAL);
  }

  _stopPolling() {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _fetchMeta() {
    try {
      const res  = await fetch(METADATA_URL);
      if (!res.ok) return;
      const data = await res.json();
      if (data.title || data.artist) {
        this._npTitle.textContent  = data.title  || '—';
        this._npArtist.textContent = data.artist || 'Live Radio';
        if (typeof document !== 'undefined') {
          document.title = `${data.title || '—'} — RadioCalico`;
        }
      }
      this._updateRecentList(data);
      this._refreshCover();
    } catch (_e) {
      // Network error — keep whatever is currently displayed
    }
  }

  _refreshCover() {
    if (!this._albumCover) return;
    const img = new Image();
    img.onload = () => {
      this._albumCover.src = img.src;
      this._albumCover.classList.add('loaded');
    };
    img.onerror = () => {
      this._albumCover.classList.remove('loaded');
    };
    img.src = `${COVER_URL}?t=${Date.now()}`;
  }

  _updateRecentList(data) {
    if (!this._rpList) return;
    const tracks = [];
    for (let i = 1; i <= 5; i++) {
      const title  = data[`prev_title_${i}`];
      const artist = data[`prev_artist_${i}`];
      if (title || artist) tracks.push({ title: title || '—', artist: artist || '' });
    }
    if (!tracks.length) return;
    this._rpList.innerHTML = tracks.map((t, i) => `
      <li class="rp-item">
        <span class="rp-num">${i + 1}</span>
        <div class="rp-info">
          <span class="rp-title">${_esc(t.title)}</span>
          ${t.artist ? `<span class="rp-artist">${_esc(t.artist)}</span>` : ''}
        </div>
      </li>`).join('');
  }

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
