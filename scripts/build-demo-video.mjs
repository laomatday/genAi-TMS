import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';

/**
 * Turns the raw Playwright recordings into files someone can actually send.
 *
 * Playwright writes VP8 in a WebM, named after the test's output directory,
 * which plays in a browser and almost nowhere else — not in Zalo, not in
 * Messenger, not in a Keynote slide. H.264 in MP4 plays everywhere that matters
 * here, so each recording is transcoded rather than handed over as-is.
 *
 * The recordings are re-encoded, not stream-copied: VP8 cannot be rewrapped
 * into MP4. yuv420p and an even frame size are required by the players that are
 * fussiest about H.264, and the `-vf` scale guards the second of those in case
 * a viewport is ever set to an odd number.
 *
 * Which H.264 encoder exists is not assumed, because on this machine none of
 * them work: the ffmpeg build has no libx264, Fedora's libopenh264 is the stub
 * that cannot create an encoder until the real codec is fetched from Cisco's
 * repo, and nvenc/vaapi/qsv all need a GPU path that is not there. So the
 * encoder is probed rather than declared, and the fallback is MPEG-4 part 2,
 * which every player that matters here opens — Zalo, Messenger, PowerPoint,
 * Keynote, QuickTime — at the cost of being a much older codec.
 *
 * The WebM is copied out alongside the MP4 rather than thrown away. It is the
 * original VP8 the browser recorded, so it is sharper than anything transcoded
 * from it, and it is the better file for anything that plays on the web.
 */

/** In preference order; the first one that can actually encode a frame wins. */
const H264_CANDIDATES = [
  { encoder: 'libx264', args: ['-preset', 'slow', '-crf', '20'] },
  { encoder: 'libopenh264', args: ['-b:v', '6M'] },
];

// MPEG-4 part 2 is far less efficient than H.264, so it is given a quality
// target instead of a bitrate — 3 is near the top of the 2-31 scale, which
// keeps small text readable where a fixed rate would smear it.
const FALLBACK = { encoder: 'mpeg4', args: ['-q:v', '3'] };

const RAW = '.cache/video-raw';
const OUT = 'demo-video';

const NAMES = [
  { match: /mobile/i, file: 'ung-dung-nhan-vien', label: 'phone walkthrough' },
  { match: /kiosk/i, file: 'man-hinh-kiosk', label: 'kiosk station' },
];

/** Can this encoder actually open? Cheapest possible answer: one frame. */
async function canEncode(encoder) {
  try {
    await run('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=1',
      '-frames:v', '1', '-c:v', encoder, '-f', 'null', '-',
    ]);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(`${command} exited ${code}\n${stderr.slice(-1200)}`))));
  });
}

async function findRecordings(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await findRecordings(path));
    else if (entry.name.endsWith('.webm')) found.push(path);
  }
  return found;
}

const recordings = await findRecordings(RAW).catch(() => []);
if (!recordings.length) {
  console.error(`No recordings under ${RAW}. Run \`bun run video\` first.`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let codec = FALLBACK;
for (const candidate of H264_CANDIDATES) {
  if (await canEncode(candidate.encoder)) { codec = candidate; break; }
}
if (codec === FALLBACK) {
  console.log('No working H.264 encoder on this machine; writing MPEG-4 part 2.');
  console.log('For H.264, install the real openh264 and re-run this script.');
}
console.log(`encoder: ${codec.encoder}\n`);

const megabytes = async (path) => `${((await stat(path)).size / 1_048_576).toFixed(1)} MB`;

for (const source of recordings) {
  const naming = NAMES.find((candidate) => candidate.match.test(source));
  if (!naming) {
    console.log(`skipping ${source} — no name rule matches it`);
    continue;
  }

  const mp4 = join(OUT, `${naming.file}.mp4`);
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', source,
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', codec.encoder, ...codec.args,
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-an', mp4,
  ]);

  const webm = join(OUT, `${naming.file}.webm`);
  await copyFile(source, webm);

  console.log(`${naming.label}`);
  console.log(`  ${mp4}   ${await megabytes(mp4)}   (gửi qua tin nhắn, chèn slide)`);
  console.log(`  ${webm}  ${await megabytes(webm)}  (bản gốc, nét hơn, dùng cho web)\n`);
}
