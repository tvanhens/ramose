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
    rot: Math.sin(t * 0.12) * 0.015,
    draw: 1,
    glow,
    alpha: 0.95,
  });
  ctx.save();
  ctx.translate(cx, cy);
  const r = 38 * scale;
  const g = ctx.createRadialGradient(0, 0, 4, 0, 0, r * 2.4);
  g.addColorStop(0, `rgba(66,211,122,${0.18 * glow})`);
  g.addColorStop(0.45, `rgba(66,211,122,${0.05 * glow})`);
  g.addColorStop(1, "rgba(66,211,122,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function rounded(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function drawChip(x, y, fact, opt = {}) {
  const w = opt.w ?? 236;
  const h = opt.h ?? 100;
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
    ctx.shadowBlur = 22 * glow;
  }

  const fill = fact.secret ? "#121812" : FOREST;
  ctx.fillStyle = fill;
  ctx.strokeStyle = fact.secret ? "#3a3a3a" : HAIR;
  ctx.lineWidth = 1.25;
  rounded(-w / 2, -h / 2, w, h, 14);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();

  const accent = fact.secret ? MUTED : GREEN;
  ctx.fillStyle = accent;
  ctx.fillRect(-w / 2, -h / 2, 5, h);

  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = MUTED;
  ctx.font = `500 13px ${MONO}`;
  ctx.fillText(fact.e, -w / 2 + 22, -h / 2 + 24);
  ctx.fillStyle = WHITE;
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText(fact.a, -w / 2 + 22, 2);
  ctx.fillStyle = fact.secret ? GREY : GREEN_BRIGHT;
  ctx.font = `500 16px ${MONO}`;
  ctx.fillText(fact.v, -w / 2 + 22, h / 2 - 22);

  ctx.textAlign = "right";
  ctx.fillStyle = MUTED;
  ctx.font = `500 12px ${MONO}`;
  ctx.fillText(`t=${fact.t}`, w / 2 - 16, -h / 2 + 24);

  if (fact.secret) {
    ctx.fillStyle = "#2a2a2a";
    rounded(w / 2 - 78, h / 2 - 30, 62, 18, 9);
    ctx.fill();
    ctx.fillStyle = GREY;
    ctx.font = `600 10px ${SANS}`;
    ctx.textAlign = "center";
    ctx.fillText("OWNER", w / 2 - 47, h / 2 - 20);
  }

  if (strike > 0) {
    ctx.strokeStyle = `rgba(166,166,166,${0.85 * strike})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-w / 2 + 18, 0);
    ctx.lineTo(w / 2 - 18, 0);
    ctx.stroke();
    ctx.beginPath();
    const k = 9;
    ctx.moveTo(w / 2 - 28 - k, -h / 2 + 20 - k);
    ctx.lineTo(w / 2 - 28 + k, -h / 2 + 20 + k);
    ctx.moveTo(w / 2 - 28 + k, -h / 2 + 20 - k);
    ctx.lineTo(w / 2 - 28 - k, -h / 2 + 20 + k);
    ctx.stroke();
  }

  ctx.restore();
}

function drawStampParts(x, y, fact, p) {
  // p: 0 blank plate, then e, a, v, t land like a press.
  const w = 420;
  const h = 220;
  const plate = smooth(0, 0.12, p);
  const eIn = smooth(0.18, 0.34, p);
  const aIn = smooth(0.36, 0.5, p);
  const vIn = smooth(0.52, 0.66, p);
  const tIn = smooth(0.68, 0.82, p);
  const press = pulse(p, 0.14, 0.28) + pulse(p, 0.34, 0.48) + pulse(p, 0.5, 0.64) + pulse(p, 0.66, 0.8);

  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = plate;

  ctx.fillStyle = "rgba(11,26,16,0.92)";
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 1.5;
  rounded(-w / 2, -h / 2, w, h, 22);
  ctx.fill();
  ctx.stroke();

  if (press > 0) {
    ctx.fillStyle = `rgba(66,211,122,${0.05 * press})`;
    rounded(-w / 2, -h / 2, w, h, 22);
    ctx.fill();
  }

  const cells = [
    { label: "entity", value: fact.e, ox: -1, oy: -1, k: eIn },
    { label: "attribute", value: fact.a, ox: 1, oy: -1, k: aIn },
    { label: "value", value: fact.v, ox: -1, oy: 1, k: vIn, accent: true },
    { label: "time", value: `t = ${fact.t}`, ox: 1, oy: 1, k: tIn, accent: true },
  ];
  const cw = 176;
  const ch = 78;
  for (const cell of cells) {
    const cx = cell.ox * 96;
    const cy = cell.oy * 48;
    ctx.save();
    ctx.globalAlpha = plate * (0.25 + 0.75 * cell.k);
    ctx.translate(cx, cy + (1 - cell.k) * 10);
    ctx.fillStyle = "#102016";
    ctx.strokeStyle = cell.k > 0.85 ? GREEN : HAIR;
    ctx.lineWidth = cell.k > 0.85 ? 1.4 : 1;
    rounded(-cw / 2, -ch / 2, cw, ch, 12);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.font = `600 11px ${SANS}`;
    ctx.letterSpacing = "0.16em";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(cell.label.toUpperCase(), 0, -20);
    ctx.letterSpacing = "0px";
    ctx.fillStyle = cell.accent && cell.k > 0.7 ? GREEN_BRIGHT : WHITE;
    ctx.font = `600 22px ${MONO}`;
    ctx.fillText(cell.value, 0, 12);
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
  ctx.font = `600 40px ${SANS}`;
  ctx.letterSpacing = "0.22em";
  ctx.fillText(title, W / 2, H - 92);
  if (sub) {
    ctx.fillStyle = GREY;
    ctx.font = `500 20px ${SANS}`;
    ctx.letterSpacing = "0.08em";
    ctx.fillText(sub, W / 2, H - 52);
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
  const w = 420;
  const h = 248;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(11,26,16,0.94)";
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 1.4;
  rounded(-w / 2, -h / 2, w, h, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#101810";
  rounded(-w / 2, -h / 2, w, 40, [18, 18, 0, 0]);
  ctx.fill();
  ctx.fillStyle = "#c45c5c";
  ctx.beginPath();
  ctx.arc(-w / 2 + 22, -h / 2 + 20, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c4a35c";
  ctx.beginPath();
  ctx.arc(-w / 2 + 40, -h / 2 + 20, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.arc(-w / 2 + 58, -h / 2 + 20, 5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = MUTED;
  ctx.font = `500 13px ${MONO}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("localhost:5173", -w / 2 + 80, -h / 2 + 20);

  ctx.fillStyle = GREY;
  ctx.font = `500 14px ${SANS}`;
  ctx.fillText("signed in as ada", -w / 2 + 28, -h / 2 + 72);
  ctx.fillStyle = GREEN;
  ctx.font = `600 13px ${SANS}`;
  ctx.letterSpacing = "0.14em";
  ctx.fillText("MEMBER", -w / 2 + 28, -h / 2 + 98);
  ctx.letterSpacing = "0px";

  ctx.fillStyle = WHITE;
  ctx.font = `600 26px ${MONO}`;
  ctx.fillText("Query.from(Issue)", -w / 2 + 28, -h / 2 + 152);

  const blink = 0.5 + 0.5 * Math.sin(t * 6);
  ctx.fillStyle = `rgba(66,211,122,${0.25 + 0.55 * blink})`;
  ctx.fillRect(-w / 2 + 28, -h / 2 + 176, 8, 22);

  ctx.fillStyle = MUTED;
  ctx.font = `500 13px ${MONO}`;
  ctx.fillText("useLiveQuery(db, q)", -w / 2 + 28, h / 2 - 28);
  ctx.restore();
}

function drawResult(x, y, a, assembled) {
  if (a <= 0.01) return;
  const w = 380;
  const h = 280;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(11,26,16,0.95)";
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = 1.3;
  rounded(-w / 2, -h / 2, w, h, 18);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = GREEN;
  ctx.font = `600 11px ${SANS}`;
  ctx.letterSpacing = "0.18em";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("LIVE  ·  FILTERED", -w / 2 + 24, -h / 2 + 28);
  ctx.letterSpacing = "0px";
  ctx.fillStyle = WHITE;
  ctx.font = `600 28px ${SANS}`;
  ctx.fillText("issue 17", -w / 2 + 24, -h / 2 + 68);

  const rows = [
    ["title", "Fix login", smooth(0.05, 0.25, assembled)],
    ["status", "done", smooth(0.22, 0.42, assembled)],
    ["note", "—", smooth(0.4, 0.62, assembled)],
  ];
  rows.forEach((row, i) => {
    const k = row[2];
    ctx.save();
    ctx.globalAlpha = a * k;
    const yy = -h / 2 + 118 + i * 46;
    ctx.fillStyle = MUTED;
    ctx.font = `500 14px ${MONO}`;
    ctx.fillText(row[0], -w / 2 + 24, yy);
    if (row[0] === "note") {
      ctx.fillStyle = MUTED;
      ctx.font = `500 16px ${SANS}`;
      ctx.fillText("absent  ·  owner only", -w / 2 + 120, yy);
    } else {
      ctx.fillStyle = WHITE;
      ctx.font = `600 18px ${SANS}`;
      ctx.fillText(row[1], -w / 2 + 120, yy);
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

function conveyorY() {
  return H * 0.5;
}

function pilePos(i) {
  const col = i % 2;
  const row = Math.floor(i / 2);
  return {
    x: 250 + col * 40,
    y: 430 + row * 78,
  };
}

function stampSchedule() {
  // Each fact is pressed, then slides to the pile.
  return [
    { fact: FACTS[0], start: 3.15, press: 1.7, slide: 0.7 },
    { fact: FACTS[1], start: 5.2, press: 1.55, slide: 0.7 },
    { fact: FACTS[2], start: 7.15, press: 1.55, slide: 0.7 },
    { fact: FACTS[3], start: 10.55, press: 1.45, slide: 0.65 },
    { fact: FACTS[4], start: 12.15, press: 1.2, slide: 0.55 },
    { fact: FACTS[5], start: 13.15, press: 1.1, slide: 0.5 },
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

function sorterProgress(i, t) {
  // Facts enter the line after the query is posed.
  const start = 18.35 + i * 1.05;
  const travel = 3.35;
  const u = clamp((t - start) / travel, 0, 1);
  return { start, u, active: t >= start };
}

function draw(t) {
  ctx.fillStyle = BLACK;
  ctx.fillRect(0, 0, W, H);

  // Slow forest wash that breathes.
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

  const titleIn = smooth(0.15, 1.1, t) * (1 - smooth(2.7, 3.5, t));
  const markDraw = easeInOut(smooth(0.2, 2.15, t));
  if (titleIn > 0.01 || t < 4) {
    drawMark({
      x: W / 2,
      y: H * 0.4,
      scale: lerp(2.15, 2.35, Math.sin(t * 0.35) * 0.5 + 0.5),
      draw: markDraw,
      glow: 0.6,
      alpha: titleIn * 0.95 + (t < 3.4 ? 0 : 0),
    });
    ctx.save();
    ctx.globalAlpha = titleIn;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = GREEN;
    ctx.font = `600 15px ${SANS}`;
    ctx.letterSpacing = "0.46em";
    ctx.fillText("RAMOSE", W / 2, H * 0.4 - 210);
    ctx.fillStyle = WHITE;
    ctx.font = `600 56px ${SANS}`;
    ctx.letterSpacing = "0.16em";
    ctx.fillText("HOW A QUERY IS MADE", W / 2, H * 0.4 + 210);
    ctx.fillStyle = GREY;
    ctx.font = `500 18px ${SANS}`;
    ctx.letterSpacing = "0.12em";
    ctx.fillText("a short film about facts, policy, and the frontend", W / 2, H * 0.4 + 258);
    ctx.restore();
  }

  // Residual watermark mark during later scenes.
  const wm = smooth(3.4, 4.2, t) * (1 - smooth(33.2, 35.2, t));
  if (wm > 0.01 && t > 3.2) {
    const sorter = smooth(17.6, 19.2, t);
    const cx = lerp(W * 0.58, W * 0.5, sorter);
    const cy = lerp(H * 0.42, H * 0.46, sorter);
    const sc = lerp(1.15, 2.05, sorter);
    const open = 0.4 + 0.6 * Math.sin(clamp((t - 19) / 8, 0, 1) * Math.PI);
    if (sorter > 0.15) drawAperture(cx, cy, sc, t, open);
    else
      drawMark({
        x: cx,
        y: cy,
        scale: sc,
        draw: 1,
        glow: 0.15,
        alpha: 0.18 * wm,
      });
  }

  // Press + pile
  const sched = stampSchedule();
  const pressAlpha = smooth(3.05, 3.6, t) * (1 - smooth(16.6, 18.1, t));
  if (pressAlpha > 0.01) {
    ctx.save();
    ctx.globalAlpha = pressAlpha;
    // Press housing
    const px = 1180;
    const py = 470;
    ctx.fillStyle = "rgba(16,24,18,0.45)";
    rounded(px - 270, py - 210, 540, 40, 8);
    ctx.fill();
    ctx.fillStyle = MUTED;
    ctx.font = `600 12px ${SANS}`;
    ctx.letterSpacing = "0.2em";
    ctx.textAlign = "center";
    ctx.fillText("FACT  PRESS  ·  E  A  V  T", px, py - 188);
    ctx.restore();

    for (const entry of sched) {
      const st = factState(entry, t);
      if (st.local < 0) continue;
      if (st.pressP < 1) {
        ctx.save();
        ctx.globalAlpha = pressAlpha;
        drawStampParts(1180, 500, entry.fact, st.pressP);
        ctx.restore();
      }
    }
  }

  // Chips in the pile / traveling / rejected
  for (let i = 0; i < sched.length; i++) {
    const entry = sched[i];
    const st = factState(entry, t);
    if (st.local < 0) continue;
    const pile = pilePos(i);
    let x = 1180;
    let y = 500;
    let scale = 1;
    let alpha = pressAlpha;
    let glow = 0;
    let strike = 0;
    let shatter = 0;

    if (st.pressP < 1) {
      // still on the press as a compact chip only at the very end of the press
      if (st.pressP < 0.86) continue;
      alpha = pressAlpha * smooth(0.86, 1, st.pressP);
      scale = lerp(0.55, 0.82, smooth(0.86, 1, st.pressP));
    } else if (!st.done) {
      const e = easeInOut(st.slideP);
      x = lerp(1180, pile.x, e);
      y = lerp(500, pile.y, e);
      scale = lerp(0.82, 0.78, e);
      alpha = pressAlpha;
    } else {
      // resting in the pile, then lifting onto the sorter
      const sort = sorterProgress(i, t);
      const lift = smooth(16.8, 18.3, t);
      x = pile.x;
      y = pile.y;
      scale = 0.78;
      alpha = lerp(pressAlpha, 1, lift);
      if (entry.fact.retired) {
        strike = smooth(11.9, 13.0, t);
      }
      if (sort.active) {
        const u = easeInOut(sort.u);
        const gateX = W * 0.5;
        const startX = pile.x + 80;
        const endX = 1580;
        x = lerp(startX, endX, u);
        y = lerp(pile.y, conveyorY() + Math.sin(u * Math.PI) * -16, u);
        scale = lerp(0.78, 0.72, u);
        glow = pulse(u, 0.42, 0.62) * (entry.fact.secret ? 0.35 : 1);
        if (entry.fact.secret && u > 0.52) {
          const rej = clamp((u - 0.52) / 0.25, 0, 1);
          shatter = easeOut(rej);
          alpha = 1 - easeIn(clamp((u - 0.55) / 0.22, 0, 1));
          y += rej * 70;
          x = gateX + (x - gateX) * (1 - rej * 0.7);
          shatterParticles(gateX + 10, conveyorY(), 900 + i, (t - sort.start - 3.35 * 0.52));
        } else if (u > 0.78) {
          // survivors fade as they become the result
          alpha *= 1 - smooth(0.82, 1, u) * 0.85;
        }
      }
    }

    if (t > 29.2 && !entry.fact.secret) alpha *= 1 - smooth(29.2, 31.2, t);
    drawChip(x, y, entry.fact, { scale, alpha, glow, strike, shatter });
  }

  // Query browser
  const qIn = smooth(15.5, 16.8, t) * (1 - smooth(28.6, 30.2, t));
  if (qIn > 0.01) {
    const qx = lerp(2100, 1580, easeOut(smooth(15.5, 17.1, t)));
    drawBrowser(qx, 250, qIn, t);
    // query beam toward the pile / gate
    if (t > 16.8 && t < 20.5) {
      const ba = pulse(t, 16.8, 20.4);
      ctx.save();
      ctx.globalAlpha = ba * 0.7;
      const grad = ctx.createLinearGradient(1400, 280, 420, 460);
      grad.addColorStop(0, GREEN);
      grad.addColorStop(1, "rgba(66,211,122,0)");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([6, 10]);
      ctx.lineDashOffset = -t * 40;
      ctx.beginPath();
      ctx.moveTo(1400, 300);
      ctx.bezierCurveTo(1100, 330, 700, 400, 420, 460);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Result card
  const resIn = smooth(27.4, 29.0, t) * (1 - smooth(32.6, 34.2, t));
  if (resIn > 0.01) {
    drawResult(1580, 520, resIn, smooth(27.6, 30.4, t));
  }

  // End card
  const end = smooth(32.4, 33.8, t);
  if (end > 0.01) {
    drawMark({
      x: W / 2,
      y: H * 0.38,
      scale: 2.05,
      draw: 1,
      glow: 0.7,
      alpha: end,
    });
    ctx.save();
    ctx.globalAlpha = end;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = WHITE;
    ctx.font = `600 52px ${SANS}`;
    ctx.letterSpacing = "0.04em";
    ctx.fillText("Query from the frontend.", W / 2, H * 0.38 + 210);
    ctx.fillStyle = GREEN;
    ctx.font = `600 28px ${SANS}`;
    ctx.letterSpacing = "0.06em";
    ctx.fillText("The database already knows who you are.", W / 2, H * 0.38 + 268);
    ctx.fillStyle = GREY;
    ctx.font = `600 18px ${SANS}`;
    ctx.letterSpacing = "0.28em";
    ctx.fillText("RAMOSE.AI", W / 2, H * 0.38 + 330);
    ctx.restore();
  }

  // Scene captions
  caption("A FACT IS FOUR THINGS", "entity  ·  attribute  ·  value  ·  time", pulse(t, 3.3, 6.6));
  caption("NOTHING IS OVERWRITTEN", "a new fact lands. the old one stays, marked gone.", pulse(t, 10.4, 13.6));
  caption("THE CLIENT ASKS FROM THE FRONTEND", "signed in as a member  ·  Query.from(Issue)", pulse(t, 15.7, 18.4));
  caption("THE POLICY LIVES IN THE DATABASE", "reads are per-fact masks. deny by default.", pulse(t, 18.6, 22.4));
  caption("READS SHRINK. THEY NEVER LEAK.", "a field you may not read is absent — not an error.", pulse(t, 22.6, 26.6));
  caption("SO THE QUERY IS ALREADY SAFE", "the browser never held the private note.", pulse(t, 27.6, 31.6));

  drawVignette();

  // Fine grain
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
