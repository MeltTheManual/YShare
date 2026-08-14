// Preview: render a few key timeline moments as stills for review.
// Usage: electron preview-main.js <filmDir> <outDir> t1 t2 t3...
// Captures via CDP Page.captureScreenshot (proven reliable in this environment).
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const FILM_DIR = process.argv[2];
const OUT = process.argv[3];
const TIMES = process.argv.slice(4).map(Number);

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
  for (const t of TIMES) {
    await win.webContents.executeJavaScript(`window.FILM.SEEK(${t})`, true);
    const shot = await win.webContents.debugger.sendCommand('Page.captureScreenshot',
      { format: 'jpeg', quality: 90, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1920, height: 1080, scale: 1 } });
    fs.writeFileSync(path.join(OUT, `t${String(t).replace('.', '_')}.jpg`),
      Buffer.from(shot.data, 'base64'));
    console.log('captured t=' + t);
  }
  app.exit(0);
}).catch((e) => { console.error('ERR', e); app.exit(1); });
