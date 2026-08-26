// How a query is made — a 36s brand film.
// Deterministic: Film.seek(t) draws the frame at t seconds.

const W = 1920;
const H = 1080;
const DURATION = 36;

const BLACK = "#0d0d0d";
const FOREST = "#0b1a10";
const GREEN = "#42d37a";
const GREEN_BRIGHT = "#6ce09a";
const WHITE = "#ffffff";
const GREY = "#a6a6a6";
const HAIR = "#1c2a21";
const MUTED = "#79847d";

const SANS = `"Manrope Variable", Inter, "Avenir Next", sans-serif`;
const MONO = `"JetBrains Mono", ui-monospace, monospace`;

const FACTS = [
  { id: "a", e: "issue 17", a: "title", v: '"Fix login"', t: 3, secret: false },
  { id: "b", e: "issue 17", a: "status", v: '"todo"', t: 3, secret: false, retired: true },
  { id: "c", e: "issue 17", a: "note", v: '"pager"', t: 5, secret: true },
  { id: "d", e: "issue 17", a: "status", v: '"done"', t: 9, secret: false },
  { id: "e", e: "issue 18", a: "title", v: '"Ship reef"', t: 6, secret: false },
  { id: "f", e: "issue 18", a: "status", v: '"doing"', t: 6, secret: false },
];

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const pulse = (t, a, b) => {
  if (t <= a || t >= b) return 0;
  const u = (t - a) / (b - a);
  return Math.sin(u * Math.PI);
};

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });
const pathEl = document.getElementById("ramose-path");
const pathLen = pathEl.getTotalLength();
const path2d = new Path2D(pathEl.getAttribute("d"));

const dust = (() => {
  const rng = mulberry32(17);
  return Array.from({ length: 90 }, () => ({
    x: rng() * W,
    y: rng() * H,
    r: 0.4 + rng() * 1.4,
    vx: (rng() - 0.5) * 8,
    vy: (rng() - 0.4) * 6,
    a: 0.04 + rng() * 0.1,
  }));
})();

function markPoint(u) {
  return pathEl.getPointAtLength(clamp(u, 0, 1) * pathLen);
}

function withMark(fn, { x, y, scale, rot = 0 }) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.translate(-152.5, -84.5);
  fn();
  ctx.restore();
}

function drawMark({ x, y, scale, rot = 0, draw = 1, glow = 0, alpha = 1 }) {
  withMark(
    () => {
      ctx.globalAlpha = alpha;
      ctx.lineCap = "butt";
      ctx.lineJoin = "round";
      ctx.lineWidth = 16;
      ctx.setLineDash([pathLen * draw, pathLen]);
      ctx.strokeStyle = WHITE;
      ctx.stroke(path2d);
      ctx.save();
      ctx.beginPath();
      ctx.rect(173, -20, 160, 220);
      ctx.clip();
      ctx.strokeStyle = GREEN;
      if (glow > 0) {
        ctx.shadowColor = GREEN;
        ctx.shadowBlur = 18 * glow;
      }
      ctx.stroke(path2d);
      ctx.restore();
      ctx.setLineDash([]);
    },
    { x, y, scale, rot },
  );
}

function drawAperture(cx, cy, scale, t, open) {
  const glow = 0.35 + 0.65 * open;
  drawMark({
    x: cx,
    y: cy,
    scale,
    rot: Math.sin(t * 0.12) * 0.012,
    draw: 1,
    glow,
    alpha: 0.96,
  });
  ctx.save();
  ctx.translate(cx, cy);
  const r = 38 * scale;
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, r * 2.4);
  g.addColorStop(0, `rgba(66,211,122,${0.22 * glow})`);
  g.addColorStop(0.45, `rgba(66,211,122,${0.06 * glow})`);
  g.addColorStop(1, "rgba(66,211,122,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // A bead of light riding the stroke — the machine is running.
  withMark(
    () => {
      const u = (t * 0.08) % 1;
      const p = markPoint(u);
      ctx.fillStyle = GREEN_BRIGHT;
      ctx.shadowColor = GREEN;
      ctx.shadowBlur = 16;
      ctx.globalAlpha = 0.55 + 0.45 * open;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
      ctx.fill();
    },
    { x: cx, y: cy, scale, rot: Math.sin(t * 0.12) * 0.012 },
  );
}

function rounded(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawChip(x, y, fact, opt = {}) {
  const w = opt.w ?? 760;
  const h = opt.h ?? 300;
  const s = opt.scale ?? 1;
  const alpha = opt.alpha ?? 1;
  const glow = opt.glow ?? 0;
  const strike = opt.strike ?? 0;
  const shatter = opt.shatter ?? 0;
  if (alpha <= 0.01) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.globalAlpha = alpha * (1 - shatter * 0.35);
  if (shatter > 0) ctx.rotate(shatter * 0.08);

  if (glow > 0) {
    ctx.shadowColor = fact.secret ? "rgba(166,166,166,0.45)" : GREEN;
    ctx.shadowBlur = 36 * glow;
  }

  const fill = fact.secret ? "#121812" : FOREST;
  ctx.fillStyle = fill;
  ctx.strokeStyle = fact.secret ? "#3a3a3a" : HAIR;
  ctx.lineWidth = 2.5;
  rounded(-w / 2, -h / 2, w, h, 22);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  const accent = fact.secret ? MUTED : GREEN;
  ctx.fillStyle = accent;
  ctx.fillRect(-w / 2, -h / 2, 10, h);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `500 32px ${MONO}`;
  ctx.fillText(fact.e, -w / 2 + 44, -h / 2 + 62);
  ctx.fillStyle = WHITE;
  ctx.font = `600 72px ${SANS}`;
  ctx.fillText(fact.a, -w / 2 + 44, 12);
  ctx.fillStyle = fact.secret ? GREY : GREEN_BRIGHT;
  ctx.font = `500 44px ${MONO}`;
  ctx.fillText(fact.v, -w / 2 + 44, h / 2 - 58);

  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.font = `500 32px ${MONO}`;
  ctx.fillText(`t=${fact.t}`, w / 2 - 36, -h / 2 + 62);

  if (fact.secret) {
    ctx.fillStyle = "#2a2a2a";
    rounded(w / 2 - 196, h / 2 - 80, 160, 48, 24);
    ctx.fill();
    ctx.fillStyle = GREY;
    ctx.font = `600 28px ${SANS}`;
    ctx.textAlign = "center";
    ctx.fillText("OWNER", w / 2 - 116, h / 2 - 54);
  }

  if (strike > 0) {
    ctx.strokeStyle = `rgba(166,166,166,${0.9 * strike})`;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 32, 8);
    ctx.lineTo(w / 2 - 32, 8);
    ctx.stroke();
    ctx.beginPath();
    const k = 16;
    ctx.moveTo(w / 2 - 48 - k, -h / 2 + 44 - k);
    ctx.lineTo(w / 2 - 48 + k, -h / 2 + 44 + k);
    ctx.moveTo(w / 2 - 48 + k, -h / 2 + 44 - k);
    ctx.lineTo(w / 2 - 48 - k, -h / 2 + 44 + k);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStampParts(x, y, fact, p) {
  const w = 1520;
  const h = 680;
  const plate = smooth(0, 0.12, p);
  const eIn = smooth(0.18, 0.34, p);
  const aIn = smooth(0.36, 0.5, p);
  const vIn = smooth(0.52, 0.66, p);
  const tIn = smooth(0.68, 0.82, p);
  const press = pulse(p, 0.14, 0.28) + pulse(p, 0.34, 0.48) + pulse(p, 0.5, 0.64) + pulse(p, 0.66, 0.8);

  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = plate;

  ctx.fillStyle = "rgba(11,26,16,0.94)";
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 2.5;
  rounded(-w / 2, -h / 2, w, h, 32);
  ctx.fill();
  ctx.stroke();

  if (press > 0) {
    ctx.fillStyle = `rgba(66,211,122,${0.06 * press})`;
    rounded(-w / 2, -h / 2, w, h, 32);
    ctx.fill();
  }

  const cells = [
    { label: "entity", value: fact.e, ox: -1, oy: -1, k: eIn },
    { label: "attribute", value: fact.a, ox: 1, oy: -1, k: aIn },
    { label: "value", value: fact.v, ox: -1, oy: 1, k: vIn, accent: true },
    { label: "time", value: `t = ${fact.t}`, ox: 1, oy: 1, k: tIn, accent: true },
  ];
  const cw = 640;
  const ch = 250;
  for (const cell of cells) {
    const cx = cell.ox * 350;
    const cy = cell.oy * 156;
    ctx.save();
    ctx.globalAlpha = plate * (0.25 + 0.75 * cell.k);
    ctx.translate(cx, cy + (1 - cell.k) * 16);
    ctx.fillStyle = "#102016";
    ctx.strokeStyle = cell.k > 0.85 ? GREEN : HAIR;
    ctx.lineWidth = cell.k > 0.85 ? 3 : 2;
    rounded(-cw / 2, -ch / 2, cw, ch, 20);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `600 28px ${SANS}`;
    ctx.letterSpacing = "0.12em";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cell.label.toUpperCase(), 0, -62);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = cell.accent && cell.k > 0.7 ? GREEN_BRIGHT : WHITE;
    ctx.font = `600 64px ${MONO}`;
    ctx.fillText(cell.value, 0, 36);
    ctx.restore();
  }

  ctx.restore();
}

function caption(title, sub, a) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = WHITE;
  ctx.font = `600 80px ${SANS}`;
  ctx.letterSpacing = "0.04em";
  ctx.fillText(title, W / 2, H - 128);
  if (sub) {
    ctx.fillStyle = GREY;
    ctx.font = `500 36px ${SANS}`;
    ctx.letterSpacing = "0.03em";
    ctx.fillText(sub, W / 2, H - 56);
  }
  ctx.restore();
}

function captionPair(a, b, t, holdA, holdB) {
  // Crossfade two captions across a window.
  const fa = pulse(t, holdA[0], holdA[1]);
  const fb = pulse(t, holdB[0], holdB[1]);
  caption(a[0], a[1], fa);
  caption(b[0], b[1], fb);
}

function drawBrowser(x, y, a, t) {
  if (a <= 0.01) return;
  const w = 1360;
  const h = 680;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(11,26,16,0.96)";
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 2.5;
  rounded(-w / 2, -h / 2, w, h, 28);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#101810";
  rounded(-w / 2, -h / 2, w, 64, [28, 28, 0, 0]);
  ctx.fill();
  ctx.fillStyle = "#c45c5c";
  ctx.beginPath();
  ctx.arc(-w / 2 + 36, -h / 2 + 32, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c4a35c";
  ctx.beginPath();
  ctx.arc(-w / 2 + 66, -h / 2 + 32, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.arc(-w / 2 + 96, -h / 2 + 32, 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = MUTED;
  ctx.font = `500 32px ${MONO}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("localhost:5173", -w / 2 + 150, -h / 2 + 32);

  ctx.fillStyle = GREY;
  ctx.font = `500 40px ${SANS}`;
  ctx.fillText("signed in as ada", -w / 2 + 64, -h / 2 + 168);
  ctx.fillStyle = GREEN;
  ctx.font = `600 40px ${SANS}`;
  ctx.letterSpacing = "0.12em";
  ctx.fillText("MEMBER", -w / 2 + 64, -h / 2 + 230);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = WHITE;
  ctx.font = `600 76px ${MONO}`;
  ctx.fillText("Query.from(Issue)", -w / 2 + 64, -h / 2 + 370);

  const blink = 0.5 + 0.5 * Math.sin(t * 6);
  ctx.fillStyle = `rgba(66,211,122,${0.25 + 0.55 * blink})`;
  ctx.fillRect(-w / 2 + 64, -h / 2 + 430, 18, 52);

  ctx.fillStyle = GREY;
  ctx.font = `500 40px ${MONO}`;
  ctx.fillText("useLiveQuery(db, q)", -w / 2 + 64, h / 2 - 64);
  ctx.restore();
}

function drawResult(x, y, a, assembled) {
  if (a <= 0.01) return;
  const w = 1500;
  const h = 720;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(11,26,16,0.96)";
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 3;
  rounded(-w / 2, -h / 2, w, h, 28);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = GREEN;
  ctx.font = `600 32px ${SANS}`;
  ctx.letterSpacing = "0.14em";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("LIVE  ·  FILTERED", -w / 2 + 64, -h / 2 + 64);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = WHITE;
  ctx.font = `600 72px ${SANS}`;
  ctx.fillText("issue 17", -w / 2 + 64, -h / 2 + 156);

  const rows = [
    ["title", "Fix login", smooth(0.05, 0.25, assembled)],
    ["status", "done", smooth(0.22, 0.42, assembled)],
    ["note", "—", smooth(0.4, 0.62, assembled)],
  ];
  rows.forEach((row, i) => {
    const k = row[2];
    ctx.save();
    ctx.globalAlpha = a * k;
    const yy = -h / 2 + 268 + i * 100;
    ctx.fillStyle = MUTED;
    ctx.font = `500 36px ${MONO}`;
    ctx.fillText(row[0], -w / 2 + 64, yy);
    if (row[0] === "note") {
      ctx.fillStyle = MUTED;
      ctx.font = `600 42px ${SANS}`;
      ctx.fillText("absent  ·  owner only", -w / 2 + 280, yy);
    } else {
      ctx.fillStyle = WHITE;
      ctx.font = `600 48px ${SANS}`;
      ctx.fillText(row[1], -w / 2 + 280, yy);
    }
    ctx.restore();
  });
  ctx.restore();
}

function drawDust(t) {
  ctx.save();
  for (const d of dust) {
    const x = (d.x + d.vx * t + W) % W;
    const y = (d.y + d.vy * t + H) % H;
    ctx.fillStyle = `rgba(255,255,255,${d.a})`;
    ctx.beginPath();
    ctx.arc(x, y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawVignette() {
  const g = ctx.createRadialGradient(W / 2, H / 2, 280, W / 2, H / 2, 860);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function drawFloor() {
  ctx.save();
  const g = ctx.createLinearGradient(0, H * 0.62, 0, H);
  g.addColorStop(0, "rgba(11,26,16,0)");
  g.addColorStop(1, "rgba(11,26,16,0.55)");
  ctx.fillStyle = g;
  ctx.fillRect(0, H * 0.62, W, H * 0.38);
  ctx.strokeStyle = "rgba(28,42,33,0.7)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 8; i++) {
    const y = H * 0.7 + i * 28;
    ctx.globalAlpha = 0.18 - i * 0.015;
    ctx.beginPath();
    ctx.moveTo(80, y);
    ctx.lineTo(W - 80, y);
    ctx.stroke();
  }
  ctx.restore();
}

function shatterParticles(cx, cy, seed, age) {
  if (age <= 0 || age > 1.6) return;
  const rng = mulberry32(seed);
  ctx.save();
  for (let i = 0; i < 36; i++) {
    const ang = rng() * Math.PI * 2;
    const dist = (20 + rng() * 160) * easeOut(clamp(age / 1.1, 0, 1));
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist + age * age * 90;
    const a = (1 - age / 1.6) * (0.25 + rng() * 0.6);
    ctx.fillStyle = rng() > 0.55 ? `rgba(66,211,122,${a})` : `rgba(166,166,166,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, 1.2 + rng() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

const RAIL_Y = 500;
const GATE_X = 960;
const PRESS_X = 960;
const PRESS_Y = 470;
const PILE_X = 360;

function pilePos(i) {
  // Only the last two completed chips stay on screen, large.
  const slot = i % 2;
  return { x: PILE_X, y: 320 + slot * 240 };
}

function stampSchedule() {
  return [
    { fact: FACTS[0], start: 3.15, press: 1.7, slide: 0.7, rail: 0 },
    { fact: FACTS[1], start: 5.2, press: 1.55, slide: 0.7, rail: null },
    { fact: FACTS[2], start: 7.15, press: 1.55, slide: 0.7, rail: 1 },
    { fact: FACTS[3], start: 10.55, press: 1.45, slide: 0.65, rail: 2 },
    { fact: FACTS[4], start: 12.2, press: 1.15, slide: 0.55, rail: 3 },
  ];
}

function factState(entry, t) {
  const local = t - entry.start;
  const pressP = clamp(local / entry.press, 0, 1);
  const after = local - entry.press;
  const slideP = clamp(after / entry.slide, 0, 1);
  const done = after > entry.slide;
  return { local, pressP, slideP, done, after };
}

function sorterProgress(order, t) {
  const start = 19.15 + order * 1.55;
  const travel = 3.8;
  const u = clamp((t - start) / travel, 0, 1);
  return { start, u, active: t >= start, travel };
}

function drawRail(t, a) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  const y = RAIL_Y + 58;
  const grad = ctx.createLinearGradient(180, y, 1740, y);
  grad.addColorStop(0, "rgba(66,211,122,0)");
  grad.addColorStop(0.22, "rgba(66,211,122,0.18)");
  grad.addColorStop(0.5, "rgba(66,211,122,0.55)");
  grad.addColorStop(0.78, "rgba(66,211,122,0.18)");
  grad.addColorStop(1, "rgba(66,211,122,0)");
  ctx.strokeStyle = grad;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(200, y);
  ctx.lineTo(1720, y);
  ctx.stroke();

  // Moving ticks — a belt.
  ctx.setLineDash([14, 22]);
  ctx.lineDashOffset = -t * 46;
  ctx.globalAlpha = a * 0.45;
  ctx.strokeStyle = "rgba(166,166,166,0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(220, y + 10);
  ctx.lineTo(1700, y + 10);
  ctx.stroke();
  ctx.restore();
}

function drawGate(t, a) {
  if (a <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = a;
  const pulseA = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 3.2));
  const h = 280;
  const g = ctx.createLinearGradient(GATE_X, RAIL_Y - h / 2, GATE_X, RAIL_Y + h / 2);
  g.addColorStop(0, "rgba(66,211,122,0)");
  g.addColorStop(0.5, `rgba(66,211,122,${0.55 * pulseA})`);
  g.addColorStop(1, "rgba(66,211,122,0)");
  ctx.strokeStyle = g;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(GATE_X, RAIL_Y - h / 2);
  ctx.lineTo(GATE_X, RAIL_Y + h / 2);
  ctx.stroke();
  ctx.fillStyle = GREEN;
  ctx.font = `600 28px ${SANS}`;
  ctx.letterSpacing = "0.2em";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("POLICY", GATE_X, RAIL_Y - h / 2 - 28);
  ctx.restore();
}

function draw(t) {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  const wash = ctx.createRadialGradient(
    W * 0.5 + Math.sin(t * 0.2) * 40,
    H * 0.42,
    80,
    W * 0.5,
    H * 0.45,
    820,
  );
  wash.addColorStop(0, "rgba(11,26,16,0.95)");
  wash.addColorStop(1, "rgba(13,13,13,0)");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  drawFloor();
  drawDust(t);

  const titleIn = smooth(0.04, 0.65, t) * (1 - smooth(2.9, 3.55, t));
  const markDraw = easeInOut(smooth(0.0, 1.25, t));
  if (titleIn > 0.01) {
    drawMark({
      x: W / 2,
      y: H * 0.38,
      scale: lerp(2.7, 2.85, Math.sin(t * 0.35) * 0.5 + 0.5),
      draw: markDraw,
      glow: 0.75,
      alpha: titleIn,
    });
    ctx.save();
    ctx.globalAlpha = titleIn;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = GREEN;
    ctx.font = `600 36px ${SANS}`;
    ctx.letterSpacing = "0.32em";
    ctx.fillText("RAMOSE", W / 2, H * 0.38 - 268);
    ctx.fillStyle = WHITE;
    ctx.font = `600 96px ${SANS}`;
    ctx.letterSpacing = "0.04em";
    ctx.fillText("HOW A QUERY IS MADE", W / 2, H * 0.38 + 268);
    ctx.fillStyle = GREY;
    ctx.font = `500 40px ${SANS}`;
    ctx.letterSpacing = "0.03em";
    ctx.fillText("a short film about facts, policy, and the frontend", W / 2, H * 0.38 + 348);
    ctx.restore();
  }

  const factory = smooth(17.8, 19.1, t) * (1 - smooth(31.8, 33.4, t));
  if (factory > 0.01) {
    drawAperture(GATE_X, RAIL_Y - 8, 1.85, t, 0.55 + 0.45 * Math.sin((t - 19) * 0.35 + 0.4));
    drawRail(t, factory);
    drawGate(t, factory);
  }

  const sched = stampSchedule();
  const pressAlpha = smooth(3.05, 3.55, t) * (1 - smooth(15.1, 16.5, t));
  if (pressAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = pressAlpha;
    ctx.fillStyle = "rgba(16,24,18,0.55)";
    rounded(PRESS_X - 420, PRESS_Y - 400, 840, 64, 14);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = `600 28px ${SANS}`;
    ctx.letterSpacing = "0.16em";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("FACT  PRESS  ·  E  A  V  T", PRESS_X, PRESS_Y - 368);
    ctx.restore();

    for (const entry of sched) {
      const st = factState(entry, t);
      if (st.local < 0 || st.pressP >= 1) continue;
      ctx.save();
      ctx.globalAlpha = pressAlpha;
      drawStampParts(PRESS_X, PRESS_Y, entry.fact, st.pressP);
      ctx.restore();
    }
  }

  let maskedLabel = 0;
  for (let i = 0; i < sched.length; i++) {
    const entry = sched[i];
    const st = factState(entry, t);
    if (st.local < 0) continue;
    let x = 0;
    let y = 0;
    let scale = 1;
    let alpha = 0;
    let glow = 0;
    let strike = 0;
    let shatter = 0;

    // Overwrite beat: two large chips, side by side. No pile of miniatures.
    if (entry.fact.retired) {
      const show = smooth(12.15, 12.7, t) * (1 - smooth(14.6, 15.4, t));
      x = 480;
      y = 460;
      alpha = show;
      strike = smooth(12.2, 13.0, t);
    } else if (entry.fact.a === "status" && entry.fact.v === '"done"') {
      const show = smooth(12.15, 12.7, t) * (1 - smooth(14.6, 15.4, t));
      x = 1440;
      y = 460;
      alpha = show;
    }

    if (entry.rail !== null) {
      const sort = sorterProgress(entry.rail, t);
      if (sort.active) {
        const u = easeInOut(sort.u);
        x = lerp(160, 1760, u);
        y = RAIL_Y;
        scale = 1.28;
        alpha = 1;
        glow = pulse(u, 0.4, 0.58);
        strike = 0;
        if (entry.fact.secret && u > 0.46) {
          const rej = clamp((u - 0.46) / 0.22, 0, 1);
          shatter = easeOut(rej);
          alpha = 1 - easeIn(clamp((u - 0.5) / 0.2, 0, 1));
          y = RAIL_Y + easeIn(rej) * 140;
          x = GATE_X + (x - GATE_X) * (1 - rej * 0.85);
          glow = 0;
          shatterParticles(GATE_X, RAIL_Y, 904, t - sort.start - sort.travel * 0.46);
          maskedLabel = pulse(t, sort.start + sort.travel * 0.48, sort.start + sort.travel * 0.48 + 2.4);
        } else if (!entry.fact.secret && u > 0.8) {
          alpha *= 1 - smooth(0.82, 1, u);
        }
      }
    }

    if (t > 29.4) alpha *= 1 - smooth(29.4, 31.4, t);
    if (alpha > 0.01) drawChip(x, y, entry.fact, { scale, alpha, glow, strike, shatter });
  }

  if (maskedLabel > 0.01) {
    ctx.save();
    ctx.globalAlpha = maskedLabel;
    ctx.fillStyle = GREY;
    ctx.font = `600 56px ${SANS}`;
    ctx.letterSpacing = "0.22em";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("MASKED", GATE_X, RAIL_Y + 190);
    ctx.restore();
  }

  const qIn = smooth(15.2, 16.4, t) * (1 - smooth(17.8, 18.8, t));
  if (qIn > 0.01) {
    drawBrowser(960, 430, qIn, t);
  }

  const resIn = smooth(27.6, 29.1, t) * (1 - smooth(32.5, 34.0, t));
  if (resIn > 0.01) {
    drawResult(960, 470, resIn, smooth(27.8, 30.6, t));
  }

  const end = smooth(32.3, 33.7, t);
  if (end > 0.01) {
    drawMark({
      x: W / 2,
      y: H * 0.36,
      scale: 2.55,
      draw: 1,
      glow: 0.7,
      alpha: end,
    });
    ctx.save();
    ctx.globalAlpha = end;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = WHITE;
    ctx.font = `600 84px ${SANS}`;
    ctx.letterSpacing = "0.01em";
    ctx.fillText("Query from the frontend.", W / 2, H * 0.36 + 260);
    ctx.fillStyle = GREEN;
    ctx.font = `600 48px ${SANS}`;
    ctx.letterSpacing = "0.02em";
    ctx.fillText("The database already knows who you are.", W / 2, H * 0.36 + 340);
    ctx.fillStyle = GREY;
    ctx.font = `600 36px ${SANS}`;
    ctx.letterSpacing = "0.2em";
    ctx.fillText("RAMOSE.AI", W / 2, H * 0.36 + 420);
    ctx.restore();
  }

  caption("A FACT IS FOUR THINGS", "entity  ·  attribute  ·  value  ·  time", pulse(t, 3.25, 6.5));
  caption("NOTHING IS OVERWRITTEN", "a new fact lands. the old one stays, marked gone.", pulse(t, 10.35, 13.7));
  caption("THE CLIENT ASKS FROM THE FRONTEND", "signed in as a member  ·  Query.from(Issue)", pulse(t, 15.5, 18.5));
  caption("THE POLICY LIVES IN THE DATABASE", "reads are per-fact masks. deny by default.", pulse(t, 18.7, 22.2));
  caption("READS SHRINK. THEY NEVER LEAK.", "a field you may not read is absent — not an error.", pulse(t, 22.3, 26.5));
  caption("SO THE QUERY IS ALREADY SAFE", "the browser never held the private note.", pulse(t, 27.7, 31.6));

  drawVignette();

  const rng = mulberry32((t * 1000) | 0);
  ctx.save();
  ctx.globalAlpha = 0.035;
  for (let i = 0; i < 1200; i++) {
    ctx.fillStyle = rng() > 0.5 ? "#fff" : "#000";
    ctx.fillRect(rng() * W, rng() * H, 1.2, 1.2);
  }
  ctx.restore();
}

let playing = !new URLSearchParams(location.search).has("record");
let t0 = performance.now();
let t = 0;
const record = new URLSearchParams(location.search).has("record");
if (record) document.body.classList.add("record");

function frame(now) {
  if (playing) {
    t = ((now - t0) / 1000) % (DURATION + 1.2);
  }
  draw(t);
  const hud = document.getElementById("hud");
  if (hud && !record) hud.textContent = `${t.toFixed(2)}s   space play · arrows scrub`;
  requestAnimationFrame(frame);
}

function seek(time) {
  t = clamp(time, 0, DURATION);
  t0 = performance.now() - t * 1000;
  draw(t);
}

function frameJPEG(quality = 0.92) {
  return canvas.toDataURL("image/jpeg", quality);
}

window.Film = {
  duration: DURATION,
  seek,
  draw,
  frameJPEG,
  play() {
    playing = true;
    t0 = performance.now() - t * 1000;
  },
  pause() {
    playing = false;
  },
};

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    playing = !playing;
    t0 = performance.now() - t * 1000;
  } else if (e.code === "ArrowRight") {
    playing = false;
    seek(t + 1 / 24);
  } else if (e.code === "ArrowLeft") {
    playing = false;
    seek(t - 1 / 24);
  } else if (e.key === "r") {
    seek(0);
    playing = true;
  }
});

document.fonts.ready.then(() => {
  if (record) {
    seek(0);
    window.filmReady = true;
    return;
  }
  requestAnimationFrame(frame);
});
