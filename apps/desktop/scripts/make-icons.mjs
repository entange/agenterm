// Generates the app icon and macOS tray template without image dependencies.
// Shapes are signed-distance fields rasterized with 4x4 supersampling.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'resources');

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const roundedRect = (x, y, w, h, r) => (px, py) => {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const polyline = (points, width) => (px, py) => {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best - width / 2;
};

function hex(color) {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}

/** Layers are [sdf, color, alpha] painted in order over transparency. */
function render(size, layers) {
  const data = Buffer.alloc(size * size * 4);
  const ss = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          let cr = 0;
          let cg = 0;
          let cb = 0;
          let ca = 0;
          for (const [sdf, color, alpha] of layers) {
            if (sdf(px, py) > 0) continue;
            const [lr, lg, lb] = hex(color);
            const la = alpha ?? 1;
            cr = lr * la + cr * (1 - la);
            cg = lg * la + cg * (1 - la);
            cb = lb * la + cb * (1 - la);
            ca = la + ca * (1 - la);
          }
          r += cr;
          g += cg;
          b += cb;
          a += ca;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      const alpha = a / n;
      data[i] = alpha > 0 ? Math.round(r / n / alpha) : 0;
      data[i + 1] = alpha > 0 ? Math.round(g / n / alpha) : 0;
      data[i + 2] = alpha > 0 ? Math.round(b / n / alpha) : 0;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return png(size, size, data);
}

function appIcon(size) {
  const s = size / 1024;
  const m = 100 * s;
  const layers = [[roundedRect(m, m, size - 2 * m, size - 2 * m, 185 * s), '#161C24']];
  const bands = ['#F2B84B', '#5FB3F9', '#6CCB9A'];
  bands.forEach((band, i) => {
    const y = (262 + i * 180) * s;
    layers.push([roundedRect(232 * s, y, 560 * s, 132 * s, 26 * s), '#232D3A']);
    layers.push([roundedRect(232 * s, y, 44 * s, 132 * s, 22 * s), band]);
    layers.push([roundedRect(254 * s, y, 22 * s, 132 * s, 0), band]);
  });
  const trace = [
    [300, 328], [380, 328], [420, 290], [462, 372], [500, 300], [540, 328], [740, 328]
  ].map(([x, y]) => [x * s, y * s]);
  layers.push([polyline(trace, 20 * s), '#F2B84B']);
  return render(size, layers);
}

function trayTemplate(size) {
  const s = size / 16;
  const layers = [];
  for (let i = 0; i < 3; i++) {
    const y = (2.5 + i * 4) * s;
    layers.push([roundedRect(1.5 * s, y, 2.5 * s, 3 * s, 0.6 * s), '#000000']);
    layers.push([roundedRect(5 * s, y, 9.5 * s, 3 * s, 0.8 * s), '#000000', i === 0 ? 1 : 0.55]);
  }
  return render(size, layers);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), appIcon(1024));
fs.writeFileSync(path.join(out, 'trayTemplate.png'), trayTemplate(16));
fs.writeFileSync(path.join(out, 'trayTemplate@2x.png'), trayTemplate(32));
console.log('icons written to', out);
