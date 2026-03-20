# Scoreboard OCR — browser edition

A **local, browser-based OCR tool** designed to run on mobile devices.  
Point your phone's back camera at a real scoreboard, draw masks over the score and time areas, and the app will continuously read those values using [Tesseract.js](https://github.com/naptha/tesseract.js).

---

## Features

| Feature | Detail |
|---|---|
| 📷 Camera | Uses the device's back (environment) camera |
| 🎯 Mask editor | Draw a rectangle over the SCORE region |
| ⏱ Mask editor | Draw a rectangle over the TIME region |
| 🔄 Invert Colors | Toggle for dark-text-on-light vs light-text-on-dark scoreboards |
| 🖼 Preview | Shows the pre-processed image fed to the OCR engine |
| ✅ Local | All OCR runs in the browser – no server, no data upload |

---

## Quick Start

### Option 1 – Python (simplest, no dependencies)

```bash
# In the project directory:
python3 -m http.server 8080
```

Then open `http://localhost:8080` in Chrome/Firefox on the same machine,  
**or** open `http://<your-local-IP>:8080` on your Android device while on  
the same Wi-Fi network.

> **Note:** Android Chrome requires the page to be served over **HTTPS** or  
> **localhost** to allow camera access. For a LAN URL you need HTTPS.  
> The easiest solution for LAN access is `npx serve --ssl` (see Option 2).

### Option 2 – Node + `serve` (HTTPS, Android-friendly)

```bash
npm install -g serve
serve -s . --ssl
```

Accept the self-signed certificate warning in Chrome on your Android device,  
then open the displayed HTTPS URL.

### Option 3 – VS Code Live Server

Install the *Live Server* extension and click **Go Live**.  
For Android access, use the HTTPS tunnel feature or your LAN IP with HTTPS.

---

## How to Use

1. **Open the app** in Chrome on your Android device.
2. Tap **📷 Start Camera** — grant camera permission when prompted.
3. Tap **🎯 Set Score Mask** and drag a rectangle over the score digits on the live camera feed.
4. Tap **⏱ Set Time Mask** and drag a rectangle over the clock/time digits.
5. Tap **▶ Start OCR** — recognised values appear in the SCORE and TIME cards below the feed.
6. If digits are not recognised correctly, try tapping **🔄 Invert Colors** to flip the binarization (useful for light-coloured digits on a dark scoreboard).

---

## Browser Compatibility

| Browser | Camera | OCR |
|---|---|---|
| Chrome for Android 90+ | ✅ | ✅ |
| Firefox for Android 90+ | ✅ | ✅ |
| Chrome for iOS 90+ | ✅ | ✅ |
| Safari iOS 14.5+ | ✅ | ✅ |
| Desktop Chrome / Firefox | ✅ (uses webcam) | ✅ |

---

## Architecture

```
index.html   – HTML shell
style.css    – Mobile-first dark theme
app.js       – Camera init, mask drawing, Tesseract.js OCR, image preprocessing
```

**Image pre-processing pipeline** (improves OCR on LED/LCD scoreboards):
1. Crop the video frame to the masked region
2. Scale up 3× (Tesseract works better on larger images)
3. Convert to grayscale
4. Apply **Otsu's automatic threshold** → binary image
5. Optional invert (toggle via button)

---

## Reference Scoreboard

The target scoreboard format is based on:  
<https://rafaelzacarias.github.io/virtual-scoreboard/>
