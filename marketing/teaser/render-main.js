// Frame renderer: loads film.html into an off-desktop 1920x1080 window, seeks the
// deterministic timeline frame by frame, and saves each frame as JPEG via CDP.
// Usage: electron render-main.js <filmDir> <outDir> [fps]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const FILM_DIR = process.argv[2];
const OUT = process.argv[3];
const FPS = Number(process.argv[4] || 30);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({
    width: 1920, height: 1080, show: false, frame: false, useContentSize: true,
    x: -4200, y: 100,
    webPreferences: { backgroundThrottling: false },
  });
  win.webContents.debugger.attach('1.3');
  const forceViewport = () => win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  win.showInactive();
  await win.loadFile(path.join(FILM_DIR, process.env.FILM_FILE || 'film.html'));
  await forceViewport();
  await win.webContents.executeJavaScript('window.FILM.ready()', true);
  const duration = await win.webContents.executeJavaScript('window.FILM.DURATION', true);
  const total = Math.round(duration * FPS);
  console.log(`rendering ${total} frames at ${FPS}fps...`);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await win.webContents.executeJavaScript(`window.FILM.SEEK(${t})`, true);
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot',
      { format: 'jpeg', quality: 93, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    fs.writeFileSync(path.join(OUT, `f${String(i).padStart(4, '0')}.jpg`),
      Buffer.from(shot.data, 'base64'));
    if (i % 150 === 0) console.log(`frame ${i}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`DONE ${total} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  app.exit(0);
}).catch((e) => { console.error('RENDER ERR', e); app.exit(1); });
