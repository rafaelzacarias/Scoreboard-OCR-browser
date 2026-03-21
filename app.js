/**
 * Scoreboard OCR – app.js
 *
 * Features
 * --------
 * • Back-camera stream via MediaDevices.getUserMedia
 * • Pointer-event mask drawing (works for both touch and mouse)
 * • Masks stored as relative [0-1] coordinates so they survive
 *   canvas/video resize events
 * • Per-mask image pre-processing (grayscale → Otsu threshold →
 *   optional invert) before feeding Tesseract.js
 * • Tesseract.js worker shared across both masks; all OCR runs
 *   locally inside the browser
 */

/* ─── Constants ──────────────────────────────────────────────── */
const MASK_COLORS = { score: '#69f0ae', time: '#4fc3f7' };
const MASK_LABELS = { score: 'SCORE', time: 'TIME' };
// Characters expected on a scoreboard
const OCR_WHITELIST = '0123456789:.-/ ';
// Tesseract page-segmentation mode 7 = SINGLE_LINE (best for scoreboard regions)
const PSM_SINGLE_LINE = '7';
// ITU-R BT.601 luma coefficients for RGB → grayscale
const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
// Minimum rectangle size (canvas px) to accept a drawn mask
const MIN_MASK_PX = 20;
// OCR fires at most once per this many ms
const OCR_INTERVAL_MS = 1200;
// Scale factor applied before feeding image to Tesseract (bigger = more accurate)
const OCR_SCALE = 3;
const SHORT_SHA_LENGTH = 7;
const VERSION_FETCH_TIMEOUT_MS = 8000;
// Retry attempts when the OCR worker fails to initialise
const WORKER_MAX_RETRIES = 3;
const WORKER_RETRY_DELAY_MS = 500;

/* ─── Helpers (iOS / cross-browser compat) ───────────────── */

/**
 * Create an off-DOM canvas that works on every browser, including
 * older iOS WebKit builds where OffscreenCanvas is absent or buggy.
 */
function _createCanvas(w, h) {
  // Prefer OffscreenCanvas when fully supported (Android Chrome, desktop)
  // Fall back to a detached <canvas> element (works everywhere)
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(w, h);
      // Ensure convertToBlob is available (Safari 17+), otherwise fall back
      if (typeof oc.convertToBlob === 'function') return oc;
    } catch (_) { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width  = w;
  c.height = h;
  return c;
}

/**
 * Convert a canvas (OffscreenCanvas or regular HTMLCanvasElement) to a PNG Blob.
 */
function _canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  // Regular HTMLCanvasElement – callback-based toBlob
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))),
      'image/png',
    );
  });
}

/* ─── ScoreboardOCR class ────────────────────────────────────── */
class ScoreboardOCR {
  constructor() {
    /* DOM refs */
    this.video        = document.getElementById('camera-feed');
    this.canvas       = document.getElementById('overlay-canvas');
    this.ctx          = this.canvas.getContext('2d');

    this.btnCamera    = document.getElementById('btn-camera');
    this.btnMaskScore = document.getElementById('btn-mask-score');
    this.btnMaskTime  = document.getElementById('btn-mask-time');
    this.btnClear     = document.getElementById('btn-clear-masks');
    this.btnInvert    = document.getElementById('btn-invert');
    this.btnOcr       = document.getElementById('btn-ocr');
    this.statusEl     = document.getElementById('status-text');
    this.maskInstr    = document.getElementById('mask-instruction');
    this.maskInstrTxt = document.getElementById('mask-instruction-text');
    this.btnCancelMask = document.getElementById('btn-cancel-mask');
    this.versionEl    = document.getElementById('version-text');

    this.scoreValueEl   = document.getElementById('score-value');
    this.timeValueEl    = document.getElementById('time-value');
    this.scorePreview   = document.getElementById('score-preview');
    this.timePreview    = document.getElementById('time-preview');

    /* Source picker */
    this.sourceModal    = document.getElementById('source-modal');
    this.btnSourceCam   = document.getElementById('btn-source-camera');
    this.btnSourceFile  = document.getElementById('btn-source-file');
    this.btnSourceCancel= document.getElementById('btn-source-cancel');
    this.fileInput      = document.getElementById('file-input');

    /* State */
    this.masks          = { score: null, time: null };  // relative coords
    this.currentMask    = null;   // 'score' | 'time' | null
    this.drawing        = false;
    this.drawStart      = null;
    this.drawCurrent    = null;
    this.invertColors   = false;
    this.ocrRunning     = false;
    this.ocrBusy        = false;  // prevents overlapping Tesseract calls
    this.worker         = null;
    this.workerReady    = false;
    this._paramsApplied = false;  // true once setParameters succeeds
    this._initPromise   = null;   // guards against concurrent _initWorker calls
    this.ocrTimer       = null;
    this.cameraActive   = false;
    this.animFrameId    = null;

    this._initEvents();
    this._initVersion();
  }

  /* ── Event wiring ─────────────────────────────────────────── */
  _initEvents() {
    this.btnCamera.addEventListener('click',    () => this._showSourcePicker());
    this.btnMaskScore.addEventListener('click', () => this._beginMask('score'));
    this.btnMaskTime.addEventListener('click',  () => this._beginMask('time'));
    this.btnClear.addEventListener('click',     () => this._clearMasks());
    this.btnInvert.addEventListener('click',    () => this._toggleInvert());
    this.btnOcr.addEventListener('click',       () => this._toggleOCR());
    this.btnCancelMask.addEventListener('click',() => this._cancelMask());

    /* Source picker */
    if (this.btnSourceCam)    this.btnSourceCam.addEventListener('click',    () => { this._hideSourcePicker(); this._startCamera(); });
    if (this.btnSourceFile)   this.btnSourceFile.addEventListener('click',   () => { this._hideSourcePicker(); this.fileInput.click(); });
    if (this.btnSourceCancel) this.btnSourceCancel.addEventListener('click', () => this._hideSourcePicker());
    if (this.fileInput)       this.fileInput.addEventListener('change',      (e) => this._loadVideoFile(e));

    /* Pointer events – works for touch and mouse */
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup',   (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel',(e)=> this._cancelMask());

    window.addEventListener('resize',            () => this._resizeCanvas());
  }

  /* ── Source picker ─────────────────────────────────────────── */
  _showSourcePicker() {
    if (this.sourceModal) this.sourceModal.classList.remove('hidden');
  }

  _hideSourcePicker() {
    if (this.sourceModal) this.sourceModal.classList.add('hidden');
  }

  /* ── Camera ───────────────────────────────────────────────── */
  async _startCamera() {
    this._setStatus('Requesting camera access…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      this.video.srcObject = stream;
      await new Promise((resolve) => {
        this.video.onloadedmetadata = () => {
          this.video.play();
          resolve();
        };
      });

      this.cameraActive = true;
      this._resizeCanvas();
      this._startRenderLoop();

      this._activateSource('📷 Camera Active');
    } catch (err) {
      this._setStatus(`Camera error: ${err?.message || String(err)}`);
      console.error('Camera error:', err);
    }
  }

  /* ── Video file ────────────────────────────────────────────── */
  _loadVideoFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    this._setStatus('Loading video file…');

    // Stop any existing camera stream
    if (this.video.srcObject) {
      for (const track of this.video.srcObject.getTracks()) track.stop();
      this.video.srcObject = null;
    }

    const url = URL.createObjectURL(file);
    this.video.src = url;
    this.video.loop = true;
    this.video.muted = true;

    this.video.onloadedmetadata = () => {
      this.video.play();
      this.cameraActive = true;
      this._resizeCanvas();
      this._startRenderLoop();
      this._activateSource(`📁 ${file.name}`);
    };

    this.video.onerror = () => {
      URL.revokeObjectURL(url);
      this._setStatus('Error loading video file.');
    };

    // Reset input so the same file can be re-selected
    this.fileInput.value = '';
  }

  /* ── Shared post-source-activation ─────────────────────────── */
  _activateSource(label) {
    this.btnCamera.textContent      = label;
    this.btnCamera.disabled         = false;
    this.btnMaskScore.disabled      = false;
    this.btnMaskTime.disabled       = false;
    this.btnClear.disabled          = false;
    this._setStatus('Source active. Draw masks over the SCORE and TIME areas.');
  }

  /* ── Canvas resize ────────────────────────────────────────── */
  _resizeCanvas() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width  = Math.round(rect.width);
    this.canvas.height = Math.round(rect.height);
  }

  /* ── Render loop (draws mask outlines) ───────────────────── */
  _startRenderLoop() {
    const loop = () => {
      this._drawOverlay();
      this.animFrameId = requestAnimationFrame(loop);
    };
    this.animFrameId = requestAnimationFrame(loop);
  }

  _drawOverlay() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /* Saved masks */
    for (const type of ['score', 'time']) {
      if (this.masks[type]) {
        this._drawMaskRect(this.masks[type], MASK_COLORS[type], MASK_LABELS[type]);
      }
    }

    /* Currently-being-drawn rectangle */
    if (this.drawing && this.drawCurrent) {
      const color = this.currentMask ? MASK_COLORS[this.currentMask] : '#fff';
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.setLineDash([6, 4]);
      const r = this._relFromAbs(this.drawCurrent);
      ctx.strokeRect(
        r.x * canvas.width, r.y * canvas.height,
        r.w * canvas.width, r.h * canvas.height,
      );
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  _drawMaskRect(rel, color, label) {
    const { ctx, canvas } = this;
    const x = rel.x * canvas.width;
    const y = rel.y * canvas.height;
    const w = rel.w * canvas.width;
    const h = rel.h * canvas.height;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.strokeRect(x, y, w, h);

    ctx.fillStyle = color + '2a'; // translucent fill
    ctx.fillRect(x, y, w, h);

    ctx.fillStyle = color;
    ctx.font      = 'bold 12px monospace';
    ctx.fillText(label, x + 4, y + 16);
    ctx.restore();
  }

  /* ── Mask drawing ─────────────────────────────────────────── */
  _beginMask(type) {
    this.currentMask       = type;
    this.drawing           = false;
    this.drawStart         = null;
    this.drawCurrent       = null;
    const label            = MASK_LABELS[type];
    this.maskInstrTxt.textContent = `Draw a rectangle over the ${label} area`;
    this.maskInstr.classList.remove('hidden');
    this._setStatus(`Drawing ${label} mask – drag on the camera feed.`);
  }

  _cancelMask() {
    this.currentMask = null;
    this.drawing     = false;
    this.drawStart   = null;
    this.drawCurrent = null;
    this.maskInstr.classList.add('hidden');
    this._setStatus('Mask cancelled.');
  }

  _clearMasks() {
    this.masks.score = null;
    this.masks.time  = null;
    this.scoreValueEl.textContent = '--';
    this.timeValueEl.textContent  = '--';
    this.scorePreview.style.display = 'none';
    this.timePreview.style.display  = 'none';
    this.btnOcr.disabled = true;
    if (this.ocrRunning) this._stopOCR();
    this._setStatus('Masks cleared. Draw new masks to continue.');
  }

  _toggleInvert() {
    this.invertColors = !this.invertColors;
    this.btnInvert.classList.toggle('active', this.invertColors);
    this.btnInvert.textContent = this.invertColors ? '🔄 Inverted ON' : '🔄 Invert Colors';
  }

  /* Pointer helpers */
  _getCanvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left),
      y: (e.clientY - rect.top),
    };
  }

  /** Convert an {x,y,w,h} in absolute canvas px to relative [0-1] coords */
  _relFromAbs({ x, y, w, h }) {
    return {
      x: x / this.canvas.width,
      y: y / this.canvas.height,
      w: w / this.canvas.width,
      h: h / this.canvas.height,
    };
  }

  _onPointerDown(e) {
    if (!this.currentMask) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.drawing     = true;
    this.drawStart   = this._getCanvasPos(e);
    this.drawCurrent = null;
  }

  _onPointerMove(e) {
    if (!this.drawing) return;
    e.preventDefault();
    const pos = this._getCanvasPos(e);
    this.drawCurrent = {
      x: Math.min(this.drawStart.x, pos.x),
      y: Math.min(this.drawStart.y, pos.y),
      w: Math.abs(pos.x - this.drawStart.x),
      h: Math.abs(pos.y - this.drawStart.y),
    };
  }

  _onPointerUp(e) {
    if (!this.drawing) return;
    e.preventDefault();
    this.drawing = false;

    if (
      this.drawCurrent &&
      this.drawCurrent.w > MIN_MASK_PX &&
      this.drawCurrent.h > MIN_MASK_PX
    ) {
      this.masks[this.currentMask] = this._relFromAbs(this.drawCurrent);
      const label = MASK_LABELS[this.currentMask];
      this._setStatus(`${label} mask set.${this._bothMasksSet() ? ' Ready to start OCR.' : ' Now set the other mask.'}`);
      if (this.masks.score || this.masks.time) this.btnOcr.disabled = false;
    } else {
      this._setStatus('Rectangle too small – try again.');
    }

    this.currentMask = null;
    this.drawStart   = null;
    this.drawCurrent = null;
    this.maskInstr.classList.add('hidden');
  }

  _bothMasksSet() {
    return !!(this.masks.score && this.masks.time);
  }

  /* ── Tesseract worker ─────────────────────────────────────── */

  /**
   * Public entry-point. Guards against concurrent calls and delegates to
   * _doInitWorker which contains the actual retry loop.
   */
  async _initWorker() {
    if (this.worker) return;
    // If another call is already in-flight, piggy-back on its promise
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitWorker();
    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _doInitWorker() {
    let lastErr;
    for (let attempt = 0; attempt <= WORKER_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        this._setStatus(`Retrying OCR engine (${attempt}/${WORKER_MAX_RETRIES})…`);
        const delay = WORKER_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        this._setStatus('Loading OCR engine…');
      }
      let w = null;
      let lastWorkerError = null;
      try {
        w = await Tesseract.createWorker('eng', 1, {
          logger: () => {},
          errorHandler: (err) => { lastWorkerError = err; },
        });

        await w.setParameters({
          tessedit_char_whitelist: OCR_WHITELIST,
          tessedit_pageseg_mode:  PSM_SINGLE_LINE,
        });
        this._paramsApplied = true;

        this.worker = w;
        this.workerReady = true;
        return;                       // success – stop retrying
      } catch (err) {
        lastErr = err ?? lastWorkerError;
        // Terminate the broken worker so it doesn't leak
        try { if (w) await w.terminate(); } catch (_) { /* ignore */ }
      }
    }

    // All attempts failed – surface a friendly message
    const rawDetail = lastErr?.message ?? (lastErr != null ? String(lastErr) : '');
    const detail = (
      rawDetail &&
      rawDetail !== 'undefined' &&
      rawDetail !== 'null'
    )
      ? rawDetail
      : 'failed to load – check your network connection';
    this._setStatus(`OCR engine error: ${detail}`);
    this.worker = null;
    this.workerReady = false;
    throw lastErr;
  }

  /* ── OCR toggle ───────────────────────────────────────────── */
  async _toggleOCR() {
    if (this.ocrRunning) {
      this._stopOCR();
    } else {
      await this._startOCR();
    }
  }

  async _startOCR() {
    try {
      await this._initWorker();
    } catch (_) {
      return;
    }
    this.ocrRunning = true;
    this.btnOcr.textContent = '⏹ Stop OCR';
    this.btnOcr.classList.add('active');
    this._setStatus('OCR running…');
    this.ocrTimer = setInterval(() => this._processFrame(), OCR_INTERVAL_MS);
    this._processFrame(); // fire immediately
  }

  _stopOCR() {
    this.ocrRunning = false;
    clearInterval(this.ocrTimer);
    this.ocrTimer = null;
    this.btnOcr.textContent = '▶ Start OCR';
    this.btnOcr.classList.remove('active');
    this._setStatus('OCR stopped.');
  }

  /* ── OCR processing ───────────────────────────────────────── */
  async _processFrame() {
    if (!this.ocrRunning || this.ocrBusy || !this.cameraActive || !this.worker) return;
    if (this.video.readyState < 2) return;

    this.ocrBusy = true;
    try {
      /* Capture current video frame into an offscreen canvas */
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      if (!vw || !vh) return;

      const frame = _createCanvas(vw, vh);
      const fctx  = frame.getContext('2d');
      fctx.drawImage(this.video, 0, 0, vw, vh);

      const jobs = [];
      if (this.masks.score) jobs.push(this._recognise(frame, this.masks.score, 'score'));
      if (this.masks.time)  jobs.push(this._recognise(frame, this.masks.time,  'time'));
      await Promise.all(jobs);
    } finally {
      this.ocrBusy = false;
    }
  }

  async _recognise(frame, rel, type) {
    const vw = frame.width;
    const vh = frame.height;

    /* Region in native video pixels */
    const sx = Math.round(rel.x * vw);
    const sy = Math.round(rel.y * vh);
    const sw = Math.max(1, Math.round(rel.w * vw));
    const sh = Math.max(1, Math.round(rel.h * vh));

    /* Upscale crop for Tesseract */
    const rw = sw * OCR_SCALE;
    const rh = sh * OCR_SCALE;
    const regionCanvas = _createCanvas(rw, rh);
    const rctx = regionCanvas.getContext('2d');
    rctx.imageSmoothingEnabled = false;
    rctx.drawImage(frame, sx, sy, sw, sh, 0, 0, rw, rh);

    /* Pre-process */
    this._preprocess(rctx, rw, rh);

    /* Update the small preview */
    this._updatePreview(type, regionCanvas, rw, rh);

    /* Run Tesseract */
    try {
      const blob = await _canvasToBlob(regionCanvas);
      const { data: { text } } = await this.worker.recognize(blob);
      const clean = text.replace(/[^0-9:.\-/ ]/g, '').trim();
      if (type === 'score') this.scoreValueEl.textContent = clean || '--';
      else                  this.timeValueEl.textContent  = clean || '--';
    } catch (err) {
      console.warn(`OCR error (${type}):`, err);
    }
  }

  /* ── Image pre-processing ─────────────────────────────────── */
  /**
   * 1. Grayscale
   * 2. Otsu threshold → binary image
   * 3. Optionally invert (bright-on-dark scoreboards)
   * Tesseract prefers BLACK text on WHITE background.
   */
  _preprocess(ctx, w, h) {
    const imgData = ctx.getImageData(0, 0, w, h);
    const d       = imgData.data;
    const n       = d.length / 4;

    /* Step 1 – grayscale */
    const gray = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      gray[i] = Math.round(LUMA_R * d[p] + LUMA_G * d[p + 1] + LUMA_B * d[p + 2]);
    }

    /* Step 2 – Otsu threshold */
    const t = otsuThreshold(gray);

    /* Step 3 – binarize + optional invert
       - Scoreboards often have bright digits on dark backgrounds.
       - If we are NOT inverting, we keep bright = white (text stays dark).
       - With invert mode: bright pixels become the text → white background. */
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      let v = gray[i] >= t ? 255 : 0;
      if (this.invertColors) v = 255 - v;
      d[p] = d[p + 1] = d[p + 2] = v;
      d[p + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
  }

  /* ── Preview thumbnails ───────────────────────────────────── */
  _updatePreview(type, offscreen, w, h) {
    const el = type === 'score' ? this.scorePreview : this.timePreview;
    el.style.display = 'block';
    const maxW = el.parentElement.clientWidth - 24;
    const ratio = Math.min(1, maxW / w);
    el.width  = Math.round(w * ratio);
    el.height = Math.round(h * ratio);
    const pctx = el.getContext('2d');
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(offscreen, 0, 0, w, h, 0, 0, el.width, el.height);
  }

  /* ── Status helper ────────────────────────────────────────── */
  _setStatus(msg) {
    this.statusEl.textContent = msg;
  }

  async _initVersion() {
    if (!this.versionEl) return;
    const FALLBACK = 'unknown';
    const CACHE_KEY = 'scoreboard_ocr_version';
    const CACHE_TS_KEY = 'scoreboard_ocr_version_ts';
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    try {
      const cachedVersion = localStorage.getItem(CACHE_KEY);
      const cachedTs = Number(localStorage.getItem(CACHE_TS_KEY) || 0);
      if (cachedVersion && cachedTs > 0 && Number.isFinite(cachedTs) && (Date.now() - cachedTs) < CACHE_TTL_MS) {
        this.versionEl.textContent = `Version: ${cachedVersion}`;
        return;
      }
    } catch (_) { /* localStorage unavailable; continue without cache */ }

    const hostMatch = window.location.hostname.match(/^([^.]+)\.github\.io$/i);
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    let owner = hostMatch?.[1] || null;
    let repo = pathParts[0] || (owner ? `${owner}.github.io` : null);
    if (!owner || !repo) {
      const configuredRepo = document.documentElement.dataset.repo || '';
      const [cfgOwner, cfgRepo] = configuredRepo.split('/');
      if (cfgOwner && cfgRepo) {
        owner = cfgOwner;
        repo = cfgRepo;
      }
    }
    if (!owner || !repo) {
      this.versionEl.textContent = `Version: ${FALLBACK}`;
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }
      if (response.status === 403) {
        this.versionEl.textContent = `Version: ${FALLBACK}`;
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const latestCommit = (Array.isArray(data) && data.length > 0) ? data[0] : null;
      const rawSha = latestCommit?.sha ? String(latestCommit.sha) : '';
      const sha = rawSha ? rawSha.slice(0, SHORT_SHA_LENGTH) : FALLBACK;
      this.versionEl.textContent = `Version: ${sha}`;
      if (sha !== FALLBACK) {
        try {
          localStorage.setItem(CACHE_KEY, sha);
          localStorage.setItem(CACHE_TS_KEY, String(Date.now()));
        } catch (_) { /* ignore localStorage write failures */ }
      }
    } catch (_) {
      this.versionEl.textContent = `Version: ${FALLBACK}`;
    }
  }
}

/* ─── Otsu's method for automatic threshold ─────────────────── */
/**
 * Computes the optimal binarization threshold for a grayscale array
 * using Otsu's between-class variance method.
 * @param {Uint8Array} gray – per-pixel grayscale values
 * @returns {number} threshold in [0, 255]
 */
function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  for (let i = 0; i < 256; i++) hist[i] /= total;

  let bestT = 0;
  let bestVar = 0;
  let w0 = 0, mu0 = 0;
  let mu_total = 0;
  for (let i = 0; i < 256; i++) mu_total += i * hist[i];

  let mu1_num = mu_total;

  for (let t = 0; t < 255; t++) {
    w0    += hist[t];
    mu0   += t * hist[t];
    const w1 = 1 - w0;
    if (w0 === 0 || w1 === 0) continue;
    const mu0_mean = mu0 / w0;
    const mu1_mean = (mu1_num - mu0) / w1;
    const variance = w0 * w1 * (mu0_mean - mu1_mean) ** 2;
    if (variance > bestVar) {
      bestVar = variance;
      bestT   = t;
    }
  }

  return bestT;
}

/* ─── Boot ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => new ScoreboardOCR());

/* ─── Export for testing (no-op in browsers) ─────────────────── */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ScoreboardOCR, otsuThreshold };
}
