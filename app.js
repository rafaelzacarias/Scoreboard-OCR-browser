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

    this.scoreValueEl   = document.getElementById('score-value');
    this.timeValueEl    = document.getElementById('time-value');
    this.scorePreview   = document.getElementById('score-preview');
    this.timePreview    = document.getElementById('time-preview');

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
    this.ocrTimer       = null;
    this.cameraActive   = false;
    this.animFrameId    = null;

    this._initEvents();
  }

  /* ── Event wiring ─────────────────────────────────────────── */
  _initEvents() {
    this.btnCamera.addEventListener('click',    () => this._startCamera());
    this.btnMaskScore.addEventListener('click', () => this._beginMask('score'));
    this.btnMaskTime.addEventListener('click',  () => this._beginMask('time'));
    this.btnClear.addEventListener('click',     () => this._clearMasks());
    this.btnInvert.addEventListener('click',    () => this._toggleInvert());
    this.btnOcr.addEventListener('click',       () => this._toggleOCR());
    this.btnCancelMask.addEventListener('click',() => this._cancelMask());

    /* Pointer events – works for touch and mouse */
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup',   (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel',(e)=> this._cancelMask());

    window.addEventListener('resize',            () => this._resizeCanvas());
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

      this.btnCamera.textContent      = '📷 Camera Active';
      this.btnCamera.disabled         = true;
      this.btnMaskScore.disabled      = false;
      this.btnMaskTime.disabled       = false;
      this.btnClear.disabled          = false;
      this._setStatus('Camera active. Draw masks over the SCORE and TIME areas.');
    } catch (err) {
      this._setStatus(`Camera error: ${err?.message || String(err)}`);
      console.error('Camera error:', err);
    }
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
  async _initWorker() {
    if (this.worker) return;
    this._setStatus('Loading OCR engine…');
    try {
      this.worker = await Tesseract.createWorker('eng', 1, {
        // suppress noisy logger; remove to see progress logs
        logger: () => {},
      });
      await this.worker.setParameters({
        tessedit_char_whitelist:  OCR_WHITELIST,
        tessedit_pageseg_mode:    PSM_SINGLE_LINE,
      });
      this.workerReady = true;
    } catch (err) {
      this._setStatus(`OCR engine error: ${err?.message || String(err)}`);
      this.worker = null;
      throw err;
    }
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
    if (!this.ocrRunning || this.ocrBusy || !this.cameraActive) return;
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
