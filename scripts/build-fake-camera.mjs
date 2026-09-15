/**
 * Builds the video Chromium plays back as the camera for the QR scanner shot.
 *
 * Without it the scanner viewfinder shows Chromium's built-in test pattern — a
 * green field with a spinning wedge — which is useless in a deck. Feeding it the
 * kiosk screen that was just captured makes the shot show what the scanner
 * actually looks at: a phone held up to the station.
 *
 * Optional by design. No ffmpeg, or no kiosk capture yet, and the capture falls
 * back to the built-in pattern rather than failing.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

// The tight crop is preferred: a phone is held close enough that the code fills
// the scan window. The whole station is the fallback if that crop is missing.
const SOURCE = existsSync('.cache/kiosk-qr.png')
  ? '.cache/kiosk-qr.png'
  : 'screenshots/kiosk/01-tram-qr.png';
export const FAKE_CAMERA = '.cache/fake-camera.y4m';

function has(command) {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

if (!existsSync(SOURCE)) {
  console.log(`skip: ${SOURCE} not captured yet`);
  process.exit(0);
}
if (!has('ffmpeg')) {
  console.log('skip: ffmpeg is not installed, the scanner will show the default test pattern');
  process.exit(0);
}

mkdirSync('.cache', { recursive: true });

// 720x1280 portrait, matching how a phone holds the camera. The station is
// scaled to sit inside the frame with room around it, so the viewfinder shows
// the screen standing in a space rather than filling every pixel.
const result = spawnSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-i', SOURCE,
  '-vf', 'scale=660:-1:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:0x20242E',
  '-pix_fmt', 'yuv420p',
  '-f', 'yuv4mpegpipe',
  FAKE_CAMERA,
], { stdio: 'inherit' });

if (result.status !== 0) {
  console.log('skip: ffmpeg could not build the frame, falling back to the test pattern');
  process.exit(0);
}
console.log(`built ${FAKE_CAMERA} from ${SOURCE}`);
