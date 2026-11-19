// Icons and illustrations for berry.me. Pages use {{px:name}} for an icon and
// {{art:name}} for an illustration drawn in code at build time; both are
// trusted HTML produced here.
//
// Icons are pixel-art PNGs drawn with Codex image generation (src/assets/icons,
// 128 × 128, transparent), shown small so they read as crisp mid-res pixel art.

const ICON_NAMES = new Set([
  "agent", "sandbox", "terminal", "server", "database", "route", "shield",
  "lock", "key", "doc", "brain", "image", "search", "eye",
  "phone", "laptop", "plug", "person", "globe", "coin", "clock",
  "chart", "calendar", "stack", "qr", "flag", "check", "cursor",
]);

export function icon(name) {
  if (!ICON_NAMES.has(name)) throw new Error(`Unknown icon "${name}"`);
  return `<img class="px-icon" src="/assets/icons/${name}.png" alt="" width="128" height="128" decoding="async">`;
}

/** Small deterministic PRNG so builds are reproducible. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * A data hall: three rows of racks receding into the distance, drawn with a
 * top face for depth, on a dashed floor grid with data packets moving along it.
 * Status lights blink on their own clocks.
 */
function racks() {
  const rand = random(7);
  const width = 560;
  const height = 300;
  const parts = [];
  // Floor grid: converging lines and horizontal rails.
  const vanish = { x: 280, y: 40 };
  for (let i = 0; i <= 10; i += 1) {
    const x = -140 + i * 84;
    parts.push(`<line class="rk-floor" x1="${x}" y1="${height}" x2="${vanish.x + (x - vanish.x) * 0.3}" y2="${vanish.y + 60}"/>`);
  }
  [300, 236, 186, 148, 120].forEach((y) => parts.push(`<line class="rk-floor" x1="0" y1="${y}" x2="${width}" y2="${y}"/>`));
  parts.push(`<path class="rk-path" d="M40 292 L200 292 L260 240 L420 240 L470 190"/>`);
  parts.push(`<path class="rk-path is-alt" d="M520 280 L380 280 L330 214 L170 214 L120 170"/>`);
  const rows = [
    { y: 112, scale: 0.55, count: 8, x0: 96 },
    { y: 150, scale: 0.75, count: 7, x0: 50 },
    { y: 196, scale: 1, count: 6, x0: 8 },
  ];
  for (const row of rows) {
    const w = 62 * row.scale;
    const h = 128 * row.scale;
    const gap = 26 * row.scale;
    const depth = 10 * row.scale;
    for (let r = 0; r < row.count; r += 1) {
      const x = row.x0 + r * (w + gap);
      const top = row.y - h + 40;
      parts.push(`<polygon class="rk-top" points="${x},${top} ${x + depth},${top - depth} ${x + w + depth},${top - depth} ${x + w},${top}"/>`);
      parts.push(`<polygon class="rk-side" points="${x + w},${top} ${x + w + depth},${top - depth} ${x + w + depth},${top + h - depth} ${x + w},${top + h}"/>`);
      parts.push(`<rect class="rk-frame" x="${x}" y="${top}" width="${w}" height="${h}"/>`);
      parts.push(`<rect class="rk-inner" x="${x + 2 * row.scale}" y="${top + 2 * row.scale}" width="${w - 4 * row.scale}" height="${h - 4 * row.scale}"/>`);
      const units = 12;
      const uh = (h - 10 * row.scale) / units;
      for (let u = 0; u < units; u += 1) {
        if (rand() < 0.12) continue;
        const y = top + 5 * row.scale + u * uh;
        parts.push(`<rect class="rk-unit" x="${x + 5 * row.scale}" y="${y.toFixed(1)}" width="${(w - 10 * row.scale).toFixed(1)}" height="${(uh - 1.5 * row.scale).toFixed(1)}"/>`);
        for (let l = 0; l < 2; l += 1) {
          const hot = rand() > 0.7;
          const size = Math.max(1.6, 2.6 * row.scale);
          parts.push(`<rect class="rk-led ${hot ? "is-red" : ""}" x="${(x + (8 + l * 5) * row.scale).toFixed(1)}" y="${(y + uh / 2 - size / 2).toFixed(1)}" width="${size.toFixed(1)}" height="${size.toFixed(1)}" style="animation-delay:-${(rand() * 4).toFixed(2)}s;animation-duration:${(1.2 + rand() * 3.2).toFixed(2)}s"/>`);
        }
        parts.push(`<rect class="rk-vent" x="${(x + w - 22 * row.scale).toFixed(1)}" y="${(y + uh / 2 - 1).toFixed(1)}" width="${(14 * row.scale).toFixed(1)}" height="${Math.max(1, 1.6 * row.scale).toFixed(1)}"/>`);
      }
    }
  }
  return `<svg class="racks" viewBox="0 52 ${width} ${height - 52}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

/** A dotted globe of land masses with a few lit nodes, drawn as squares. */
function globe() {
  // Very coarse equirectangular land mask (36 × 18, 10° per cell).
  const mask = [
    "....................................",
    "......####.......###############....",
    "...##########...####################",
    "..###########..#####################",
    "...#########...########.###########.",
    "....######.....#######....#######...",
    ".....####.......#######....####.#...",
    "......###......#########.....##.....",
    ".......##......#########......#.....",
    "........####....######........##....",
    "........######...#####.........#....",
    ".........#####...####........####...",
    ".........####.....###.......######..",
    "..........###.....##.........####...",
    "..........##......................#.",
    "..........#.........................",
    "....................................",
    "....................................",
  ];
  const size = 300;
  const radius = 140;
  const cx = size / 2;
  const cy = size / 2;
  const tilt = -0.35;
  const dots = [];
  const lon0 = -0.6;
  for (let lat = -80; lat <= 80; lat += 4) {
    for (let lon = -180; lon < 180; lon += 4) {
      const row = Math.floor((90 - lat) / 10);
      const col = Math.floor((lon + 180) / 10);
      if (mask[row]?.[col] !== "#") continue;
      const phi = (lat * Math.PI) / 180;
      const lambda = (lon * Math.PI) / 180 + lon0;
      const x = Math.cos(phi) * Math.sin(lambda);
      let y = Math.sin(phi);
      let z = Math.cos(phi) * Math.cos(lambda);
      const y2 = y * Math.cos(tilt) - z * Math.sin(tilt);
      z = y * Math.sin(tilt) + z * Math.cos(tilt);
      y = y2;
      if (z <= 0.22) continue;
      const px = cx + x * radius;
      const py = cy - y * radius;
      dots.push(`<rect x="${(px - 1.4).toFixed(1)}" y="${(py - 1.4).toFixed(1)}" width="2.8" height="2.8" opacity="${(0.35 + z * 0.65).toFixed(2)}"/>`);
    }
  }
  const nodes = [
    [cx - 58, cy - 40],
    [cx + 22, cy - 62],
    [cx + 66, cy - 6],
    [cx - 18, cy + 38],
    [cx + 40, cy + 54],
  ];
  const lines = nodes.slice(1).map(([x, y], index) => {
    const [x0, y0] = nodes[index];
    const mx = (x0 + x) / 2;
    const my = Math.min(y0, y) - 26;
    return `<path class="gl-arc" d="M${x0} ${y0} Q${mx} ${my} ${x} ${y}"/>`;
  });
  const lit = nodes.map(([x, y], index) => `<rect class="gl-node" x="${x - 3}" y="${y - 3}" width="6" height="6" style="animation-delay:-${index * 0.7}s"/>`);
  return `<svg class="globe" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false"><circle class="gl-rim" cx="${cx}" cy="${cy}" r="${radius + 4}"/><g class="gl-dots">${dots.join("")}</g>${lines.join("")}${lit.join("")}</svg>`;
}

const ART = { racks, globe };

export function art(name) {
  const draw = ART[name];
  if (!draw) throw new Error(`Unknown pixel art "${name}"`);
  return draw();
}

