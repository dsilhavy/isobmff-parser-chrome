// Generates public/icons/icon-{16,32,48,128}.png (nested-box motif). Run: npm run icons
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function png(size, rgba) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { rows[y * (size * 4 + 1)] = 0; rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing, normalized 0..1 coordinates ----
const BG = [0x1b, 0x2b, 0x4b], BLUE = [0x7c, 0xac, 0xf8], WHITE = [0xff, 0xff, 0xff];
const inRect = (x, y, a, b) => x >= a && x <= b && y >= a && y <= b;
const inRounded = (x, y, r) => {
  const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const stroke = (x, y, a, b, w) => inRect(x, y, a, b) && !inRect(x, y, a + w, b - w);
// nested boxes: outer outline (blue), middle outline (white), inner filled (blue)
function sample(x, y) {
  if (!inRounded(x, y, 0.2)) return null;
  if (stroke(x, y, 0.13, 0.87, 0.075)) return BLUE;
  if (stroke(x, y, 0.30, 0.70, 0.075)) return WHITE;
  if (inRect(x, y, 0.43, 0.57)) return BLUE;
  return BG;
}
function render(size, ss = 6) {
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
      if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
    }
    const i = (py * size + px) * 4;
    if (a) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; out[i + 3] = (255 * a) / (ss * ss); }
  }
  return out;
}
mkdirSync('public/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(`public/icons/icon-${s}.png`, png(s, render(s)));
console.log('ok');
