#!/usr/bin/env node
// scripts/gen-icon.mjs — the dashboard favicon, derived from the terminal art.
//
// The splash banner (tui/banner.generated.mjs) is amber dots on a dark ground
// with the hooded FIGURE as negative space. The favicon keeps that inversion —
// an amber field with the figure cut out of it — instead of the usual
// figure-on-ground, because the inversion IS the mark's identity.
//
// The grid is DERIVED, not drawn freehand: the banner's braille cells decode to
// a 96x140 dot grid; the upper half (head + shoulders, figure top at dot row
// 19) box-downsamples to 16x16 by majority-OFF per cell. What follows is that
// output centred and cleaned by hand — interior speckle filled, edges smoothed
// one pixel — with the derived row widths kept: hood 4 wide at the tip,
// shoulders bleeding off the frame at full width, exactly as in the source.
// (A straight downscale of the ARTWORK cannot work — white figure, black
// ground, black hair detail — which is why the predecessor of this file drew
// at 16px. This one still renders at 16px, but takes its shape from the art.)
//
// PNG is encoded here with node:zlib — no dependency, and every export is an
// integer multiple scaled nearest-neighbour, so all sizes are pixel-identical
// to the grid.
//
//   #  figure  --bg      #0a0a0a   (the dashboard's ground)
//   .  field   --accent  #d9b35a   (the dashboard's accent)

import zlib from 'node:zlib';

const FIELD = [0xd9, 0xb3, 0x5a];
const DARK = [0x0a, 0x0a, 0x0a];

const GRID = [
  '......####......',
  '.....######.....',
  '.....######.....',
  '....########....',
  '....########....',
  '...##########...',
  '...##########...',
  '...##########...',
  '..############..',
  '..############..',
  '.##############.',
  '.##############.',
  '################',
  '################',
  '################',
  '################',
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode the grid as an 8-bit RGB PNG at `scale` device pixels per grid cell.
 * @param {number} scale
 * @returns {Buffer}
 */
export function encodePng(scale) {
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`scale must be a positive integer, got ${scale}`);
  const n = GRID.length;
  const side = n * scale;
  // One filter byte (0 = None) per scanline, then RGB triplets.
  const raw = Buffer.alloc(side * (1 + side * 3));
  let o = 0;
  for (let y = 0; y < side; y += 1) {
    raw[o] = 0; o += 1;
    const row = GRID[Math.floor(y / scale)];
    for (let x = 0; x < side; x += 1) {
      const [r, g, b] = row[Math.floor(x / scale)] === '#' ? DARK : FIELD;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; o += 3;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type 2 = truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function dataUri(scale) {
  return `data:image/png;base64,${encodePng(scale).toString('base64')}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [label, scale] of [['16', 1], ['32', 2]]) {
    const uri = dataUri(scale);
    console.log(`${label}px (${uri.length} chars):`);
    console.log(uri);
  }
}
