// Exercise OCR from the real Windows package: unpacked workers need their transitive dependencies too.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function main() {
  if (process.argv[2] === '--ocr-worker') {
    const resources = process.argv[3];
    const { ScreenOcr } = require(path.join(resources, 'app.asar', 'dist/main/vision/ocr.js'));
    const ocr = new ScreenOcr();
    try {
      assert.equal(await ocr.init(), true, ocr.failed);
      const data = fs.readFileSync(path.join(__dirname, '../test/fixtures/ocr-victory.gray'));
      assert.equal(data.length, 320 * 70);
      const result = await ocr.read({ w: 320, h: 70, data }, 'light-text');
      assert.ok(result, 'Packaged OCR recognition failed');
      assert.match(result.text, /\bVICTORY\b/i, 'Packaged OCR did not recognize the known fixture');
      assert.equal(ocr.reads, 1);
      console.log('PACKAGED_OCR_OK');
    } finally {
      await ocr.terminate();
    }
    return;
  }

  const unpacked = path.resolve(__dirname, '../release/win-unpacked');
  const resources = path.join(unpacked, 'resources');
  for (const file of ['native/rc-audio.exe', 'app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe',
    'app.asar.unpacked/node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz']) {
    assert.ok(fs.existsSync(path.join(resources, file)), `Missing packaged dependency: ${file}`);
  }
  const files = require('@electron/asar').listPackage(path.join(resources, 'app.asar'));
  assert.ok(!files.some(file => /overwolf/i.test(file)), 'Standalone package must not contain Overwolf');
  const result = spawnSync(path.join(unpacked, 'Rivals Clipper.exe'), [__filename, '--ocr-worker', resources], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.match(result.stdout, /PACKAGED_OCR_OK/, result.stderr);
  console.log('Standalone package verified: no Overwolf, capture/audio assets present, packaged OCR works.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
