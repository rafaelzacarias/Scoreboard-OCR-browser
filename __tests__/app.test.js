/**
 * @jest-environment jsdom
 */

/* ── Minimal DOM required by ScoreboardOCR constructor ─────────── */
beforeAll(() => {
  document.body.innerHTML = `
    <video id="camera-feed"></video>
    <canvas id="overlay-canvas"></canvas>
    <div id="mask-instruction" class="hidden">
      <span id="mask-instruction-text"></span>
      <button id="btn-cancel-mask"></button>
    </div>
    <div id="score-value">--</div>
    <div id="time-value">--</div>
    <canvas id="score-preview"></canvas>
    <canvas id="time-preview"></canvas>
    <button id="btn-camera"></button>
    <button id="btn-mask-score" disabled></button>
    <button id="btn-mask-time" disabled></button>
    <button id="btn-clear-masks" disabled></button>
    <button id="btn-invert"></button>
    <button id="btn-ocr" disabled></button>
    <span id="status-text"></span>
    <span id="version-text">Version: --</span>
  `;

  // jsdom does not implement HTMLCanvasElement.getContext – stub it
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
    clearRect: jest.fn(),
    drawImage: jest.fn(),
    fillRect: jest.fn(),
    strokeRect: jest.fn(),
    fillText: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    setLineDash: jest.fn(),
    getImageData: jest.fn(() => ({ data: new Uint8ClampedArray(0) })),
    putImageData: jest.fn(),
  }));

  // Stub global Tesseract
  global.Tesseract = { createWorker: jest.fn() };

  // Stub fetch (used by _initVersion)
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 404 }));
});

const { ScoreboardOCR } = require('../app.js');

/* ── Helpers ──────────────────────────────────────────────────────── */

/**
 * Build a lightweight object that has the worker-related methods and
 * state of ScoreboardOCR without running the full constructor (which
 * binds events, starts the camera, fetches version, etc.).
 */
function createTestOCR() {
  return {
    worker: null,
    workerReady: false,
    _paramsApplied: false,
    _initPromise: null,
    ocrRunning: false,
    ocrBusy: false,
    ocrTimer: null,
    cameraActive: false,
    statusEl: { textContent: '' },
    btnOcr: {
      textContent: '',
      classList: { add: jest.fn(), remove: jest.fn() },
    },
    _setStatus: ScoreboardOCR.prototype._setStatus,
    _initWorker: ScoreboardOCR.prototype._initWorker,
    _doInitWorker: ScoreboardOCR.prototype._doInitWorker,
    _applyWorkerParams: ScoreboardOCR.prototype._applyWorkerParams,
    _ensureParams: ScoreboardOCR.prototype._ensureParams,
    _startOCR: ScoreboardOCR.prototype._startOCR,
    _stopOCR: ScoreboardOCR.prototype._stopOCR,
    _processFrame: ScoreboardOCR.prototype._processFrame,
  };
}

/** Worker whose setParameters always rejects (null internal API).  */
function brokenWorker() {
  return {
    setParameters: jest.fn().mockRejectedValue(
      "TypeError: Cannot read properties of null (reading 'SetVariable')",
    ),
    reinitialize: jest.fn().mockResolvedValue(undefined),
    recognize: jest.fn(),
    terminate: jest.fn().mockResolvedValue(undefined),
  };
}

/** Worker that works correctly. */
function healthyWorker() {
  return {
    setParameters: jest.fn().mockResolvedValue(undefined),
    reinitialize: jest.fn().mockResolvedValue(undefined),
    recognize: jest.fn().mockResolvedValue({ data: { text: '42' } }),
    terminate: jest.fn().mockResolvedValue(undefined),
  };
}

/* ── Tests ────────────────────────────────────────────────────────── */

describe('_initWorker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Tesseract.createWorker.mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('soft-fails when setParameters always fails (null API)', async () => {
    const w = brokenWorker();
    Tesseract.createWorker.mockImplementation(() =>
      Promise.resolve(w),
    );

    const ocr = createTestOCR();
    const promise = ocr._initWorker();

    // Advance time past all retry delays (inner retries + reinitialize)
    await jest.runAllTimersAsync();
    await promise;

    // Worker should still be set – soft-failure means OCR proceeds
    expect(ocr.worker).toBe(w);
    expect(ocr.workerReady).toBe(true);
    // But params were NOT successfully applied
    expect(ocr._paramsApplied).toBe(false);
    // reinitialize should have been called between retries
    expect(w.reinitialize).toHaveBeenCalled();
  });

  test('succeeds when setParameters works on an inner retry', async () => {
    // First call to setParameters fails, second succeeds
    const w = healthyWorker();
    let calls = 0;
    w.setParameters.mockImplementation(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(
          "TypeError: Cannot read properties of null (reading 'SetVariable')",
        );
      }
      return Promise.resolve(undefined);
    });
    Tesseract.createWorker.mockResolvedValue(w);

    const ocr = createTestOCR();
    const promise = ocr._initWorker();

    await jest.runAllTimersAsync();
    await promise;

    expect(ocr.worker).toBe(w);
    expect(ocr.workerReady).toBe(true);
    expect(ocr._paramsApplied).toBe(true);
    // setParameters should have been called at least twice (fail + succeed)
    expect(w.setParameters.mock.calls.length).toBeGreaterThanOrEqual(2);
    // reinitialize should have been called after the first failure
    expect(w.reinitialize).toHaveBeenCalled();
  });

  test('rejects when createWorker itself fails', async () => {
    Tesseract.createWorker.mockRejectedValue(new Error('WASM load failed'));

    const ocr = createTestOCR();
    const promise = ocr._initWorker();

    let caughtErr;
    promise.catch((e) => { caughtErr = e; });

    await jest.runAllTimersAsync();

    expect(caughtErr).toBeDefined();
    expect(ocr.worker).toBeNull();
    expect(ocr.workerReady).toBe(false);
    expect(ocr.statusEl.textContent).toMatch(/OCR engine error/);
  });

  test('concurrent calls share the same initialisation promise', async () => {
    Tesseract.createWorker.mockImplementation(() =>
      Promise.resolve(healthyWorker()),
    );

    const ocr = createTestOCR();
    const p1 = ocr._initWorker();
    const p2 = ocr._initWorker();

    await jest.runAllTimersAsync();
    await Promise.all([p1, p2]);

    // createWorker should have been called only once
    expect(Tesseract.createWorker).toHaveBeenCalledTimes(1);
    expect(ocr.workerReady).toBe(true);
  });
});

describe('_startOCR (triggered by Start OCR click)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    Tesseract.createWorker.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  test('starts OCR even when setParameters fails (soft-fail)', async () => {
    Tesseract.createWorker.mockImplementation(() =>
      Promise.resolve(brokenWorker()),
    );

    const ocr = createTestOCR();
    const promise = ocr._startOCR();

    // Use advanceTimersByTime instead of runAllTimersAsync because
    // _startOCR creates a setInterval that would loop forever.
    await jest.advanceTimersByTimeAsync(10000);
    await promise;

    // OCR should be running – soft-failure means worker is usable
    expect(ocr.ocrRunning).toBe(true);
    expect(ocr.workerReady).toBe(true);
    expect(ocr._paramsApplied).toBe(false);

    // Clean up interval created by _startOCR
    ocr._stopOCR();
  });

  test('does not throw when createWorker fails', async () => {
    Tesseract.createWorker.mockRejectedValue(new Error('WASM load failed'));

    const ocr = createTestOCR();
    const promise = ocr._startOCR();

    await jest.runAllTimersAsync();

    // _startOCR must not throw – it catches the _initWorker failure
    await expect(promise).resolves.toBeUndefined();

    // OCR must NOT be running
    expect(ocr.ocrRunning).toBe(false);
    expect(ocr.statusEl.textContent).toMatch(/OCR engine error/);
  });

  test('starts OCR successfully with a healthy worker', async () => {
    Tesseract.createWorker.mockImplementation(() =>
      Promise.resolve(healthyWorker()),
    );

    const ocr = createTestOCR();
    // Healthy path has no setTimeout delays – just await the promise
    await ocr._startOCR();

    expect(ocr.ocrRunning).toBe(true);
    expect(ocr.workerReady).toBe(true);
    expect(ocr.btnOcr.textContent).toBe('⏹ Stop OCR');

    // Clean up interval created by _startOCR
    ocr._stopOCR();
  });
});

describe('_processFrame guard', () => {
  test('returns early when worker is null', async () => {
    const ocr = createTestOCR();
    ocr.ocrRunning = true;
    ocr.cameraActive = true;
    ocr.worker = null;

    // Should not throw or attempt recognition
    await expect(ocr._processFrame()).resolves.toBeUndefined();
    expect(ocr.ocrBusy).toBe(false);
  });
});
