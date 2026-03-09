// RadioCalico – main entry point

const STREAM_URL = 'https://d3d4yli4hf5bmh.cloudfront.net/hls/live.m3u8';

const audio      = new Audio();
const playBtn    = document.getElementById('play-btn');
const iconPlay   = document.getElementById('icon-play');
const iconPause  = document.getElementById('icon-pause');
const iconLoad   = document.getElementById('icon-loading');
const volSlider   = document.getElementById('volume');
const volPct      = document.getElementById('vol-pct');
const volIconOn   = document.getElementById('vol-icon-on');
const volIconOff  = document.getElementById('vol-icon-off');
const statusBar  = document.getElementById('status-bar');
const npTitle    = document.getElementById('np-title');
const npArtist   = document.getElementById('np-artist');
const rpList     = document.getElementById('rp-list');
const albumCover = document.getElementById('album-cover');
const catIcon    = document.querySelector('.cat-icon');
const canvas     = document.getElementById('visualizer');
const ctx        = canvas.getContext('2d');

let audioCtx   = null;
let analyser   = null;
let sourceNode = null;
let animFrame  = null;

// ── Volume ──────────────────────────────────────────────────────────────────
audio.volume = parseFloat(volSlider.value);

let lastVolume = audio.volume;   // remembers pre-mute level

function setVolume(v) {
  audio.volume       = v;
  volSlider.value    = v;
  volPct.textContent = Math.round(v * 100) + '%';
  const muted = v === 0;
  volIconOn.style.display  = muted ? 'none' : '';
  volIconOff.style.display = muted ? ''     : 'none';
}

volSlider.addEventListener('input', () => {
  const v = parseFloat(volSlider.value);
  if (v > 0) lastVolume = v;   // only remember non-zero levels
  setVolume(v);
});

function toggleMute() {
  if (audio.volume > 0) {
    lastVolume = audio.volume;
    setVolume(0);
  } else {
    const restore = (lastVolume === 0 || lastVolume === 1) ? 0.8 : lastVolume;
    setVolume(restore);
  }
}

volIconOn.addEventListener('click',  toggleMute);
volIconOff.addEventListener('click', toggleMute);

// ── Status / icon helpers ────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className   = 'status-bar' + (type ? ' ' + type : '');
}

function showIcon(state) {
  iconPlay.style.display  = state === 'play'    ? '' : 'none';
  iconPause.style.display = state === 'pause'   ? '' : 'none';
  iconLoad.style.display  = state === 'loading' ? '' : 'none';
}

// ── Web Audio visualizer ─────────────────────────────────────────────────────
function setupAnalyser() {
  if (audioCtx) return;
  audioCtx   = new (window.AudioContext || window.webkitAudioContext)();
  analyser   = audioCtx.createAnalyser();
  analyser.fftSize              = 256;
  analyser.smoothingTimeConstant = 0.8;
  sourceNode = audioCtx.createMediaElementSource(audio);
  sourceNode.connect(analyser);
  analyser.connect(audioCtx.destination);
}

function drawVisualizer() {
  animFrame = requestAnimationFrame(drawVisualizer);
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!analyser) return;

  const bufLen = analyser.frequencyBinCount;
  const data   = new Uint8Array(bufLen);
  analyser.getByteFrequencyData(data);

  const barW = W / bufLen * 2;
  let   x    = 0;
  for (let i = 0; i < bufLen; i++) {
    const barH  = (data[i] / 255) * H;
    const ratio = i / bufLen;
    const r = Math.round(192 + ratio * (99  - 192));
    const g = Math.round(132 + ratio * (102 - 132));
    const b = Math.round(252 + ratio * (241 - 252));
    ctx.fillStyle = `rgba(${r},${g},${b},0.85)`;
    ctx.beginPath();
    ctx.roundRect(x, H - barH, barW - 1, barH, 2);
    ctx.fill();
    x += barW + 1;
  }
}

function resizeCanvas() {
  canvas.width  = canvas.offsetWidth  * devicePixelRatio;
  canvas.height = canvas.offsetHeight * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
drawVisualizer();

// ── StreamManager ─────────────────────────────────────────────────────────────
const manager = new StreamManager({
  audio,
  Hls,
  playBtn,
  catIcon,
  npTitle,
  npArtist,
  onStatus:       setStatus,
  onShowIcon:     showIcon,
  onQualityBadge: (text) => { document.querySelector('.quality-badge').textContent = text; },
  onDestroy: () => {
    cancelAnimationFrame(animFrame);
    animFrame = null;
    drawVisualizer();
  },
});

const nowPlaying = new NowPlaying({
  npTitle,
  npArtist,
  rpList,
  albumCover,
  HlsEvents: Hls.Events,
});

const monitor = new StreamHealthMonitor({
  audio,
  HlsEvents:      Hls.Events,
  onStatusChange: (state, details) => {
    console.log('[RadioCalico] Stream state:', state, details);
  },
  onLog:    (msg) => console.log(msg),
  onRestart: () => {
    nowPlaying.detach();
    monitor.detach();
    manager.load(STREAM_URL);        // synchronous; manager.hls is set after this
    if (manager.hls) {
      nowPlaying.attach(manager.hls, audio);
      monitor.attach(manager.hls);
    }
  },
});

const listenerBadge = document.getElementById('listener-badge');
const listenerCount = new ListenerCount({ badge: listenerBadge });
listenerCount.connect();

// ── Play / pause ─────────────────────────────────────────────────────────────
async function togglePlay() {
  if (audioCtx?.state === 'suspended') await audioCtx.resume();

  if (manager.playing) {
    audio.pause();
    manager.playing = false;
    showIcon('play');
    setStatus('Paused');
    catIcon.classList.remove('hidden');
    listenerCount.stopListening();
  } else {
    showIcon('loading');
    setStatus('Buffering…');
    try {
      setupAnalyser();
      await audio.play();
      manager.playing = true;
      showIcon('pause');
      setStatus('Playing · lossless HLS', 'ok');
      catIcon.classList.add('hidden');
      listenerCount.startListening();
    } catch (err) {
      setStatus('Playback error: ' + err.message, 'error');
      showIcon('play');
    }
  }
}

playBtn.addEventListener('click', togglePlay);

// ── Auto-load on startup ──────────────────────────────────────────────────────
manager.load(STREAM_URL);
if (manager.hls) {
  nowPlaying.attach(manager.hls, audio);
  monitor.attach(manager.hls);
}

// ── Audio events ─────────────────────────────────────────────────────────────
audio.addEventListener('waiting', () => { if (manager.playing) setStatus('Buffering…'); });
audio.addEventListener('playing', () => { if (manager.playing) setStatus('Playing · lossless HLS', 'ok'); });
audio.addEventListener('stalled', () => setStatus('Stream stalled…', 'error'));
audio.addEventListener('error',   () => setStatus('Audio error.', 'error'));
