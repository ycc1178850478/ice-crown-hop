
"use strict";

const stage = document.querySelector("#game");
const canvas = document.querySelector("#world");
const ctx = canvas.getContext("2d", { alpha: false });
const background = document.createElement("canvas");
const bg = background.getContext("2d");
const ui = Object.fromEntries(
  ["intro", "result", "start-btn", "retry", "mute", "fullscreen", "hold", "hold-text",
    "score", "best", "result-copy", "score-message", "meter", "meter-fill"].map(
    (id) => [id, document.getElementById(id)])
);
const scoreboard = document.querySelector(".scoreboard");
const controls = document.querySelector(".controls");
const atlas = new Image();
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const params = new URLSearchParams(location.search);
const seed = params.has("seed") ? Number(params.get("seed")) : Math.floor(Math.random() * 0x7fffffff);
const chargeLimit = 1.08;
const minDistance = 55;
const maxDistance = 302;
let width = 0;
let height = 0;
let pixelRatio = 1;
let scale = 1;
let mobileLayout = false;
let clock = 0;
let random = makeRandom(seed);
let input = null;
let externalClock = false;
let audio = null;
let muted = getSetting("mute", "false") === "true";
let record = Number(getSetting("best", "0")) || 0;
let particles = [];
let state = {};
let screen = { x: 0, y: 0, anchorX: 0, anchorY: 0 };
let lastUI = "";
let previousFrame = performance.now();

function getSetting(key, fallback) {
  try { return localStorage.getItem("ice-crown-hop:" + key) ?? fallback; }
  catch { return fallback; }
}

function saveSetting(key, value) {
  try { localStorage.setItem("ice-crown-hop:" + key, String(value)); }
  catch { /* The game remains playable with storage disabled. */ }
}

function makeRandom(initial) {
  let value = initial >>> 0;
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function clamp(value, low = 0, high = 1) {
  return Math.max(low, Math.min(high, value));
}

function lerp(a, b, fraction) {
  return a + (b - a) * fraction;
}

function distanceFromCharge(charge) {
  return lerp(minDistance, maxDistance, clamp(charge / chargeLimit));
}

function createPath() {
  const platforms = [{ x: 0, y: 0, half: 57, depth: 80 }];
  for (let i = 1; i < 8; i++) addPlatform(platforms, i);
  return platforms;
}

function addPlatform(platforms, index) {
  const last = platforms[platforms.length - 1];
  const right = index === 1 || (index > 2 && random() > 0.44);
  const distance = index === 1 ? 169 : Math.round(145 + random() * 73 + Math.min(index, 18) * 1.45);
  const half = index === 1 ? 48 : Math.round(48 + random() * 9 - Math.min(index, 28) * .57);
  platforms.push({
    x: last.x + (right ? distance : 0),
    y: last.y + (right ? 0 : distance),
    half,
    depth: Math.round(57 + random() * 38),
  });
}

function reset(mode) {
  random = makeRandom(seed);
  state = {
    mode, platforms: createPath(), step: 0, total: 0, score: 0, charge: 0,
    x: 0, y: 0, z: 0, turn: "right", jump: null, elapsed: 0, land: 0,
    message: "", messageTTL: 0, newRecord: false, settleX: 0, settleY: 0,
  };
  particles = [];
  input = null;
  screen.x = screen.y = 0;
  camera(0, true);
  syncUI();
}

function syncUI() {
  const { mode, score, charge, message, messageTTL } = state;
  const value = mode === "charging" ? Math.round(100 * clamp(charge / chargeLimit)) : 0;
  const status = [mode, score, record, value, messageTTL > 0 ? message : "", muted].join("|");
  if (status === lastUI) return;
  lastUI = status;
  stage.dataset.mode = mode;
  ui.intro.hidden = mode !== "intro";
  scoreboard.hidden = mode === "intro";
  ui.result.hidden = mode !== "over";
  controls.hidden = ["intro", "drop", "over"].includes(mode);
  ui.score.value = String(score);
  ui.best.textContent = record;
  ui["score-message"].textContent = messageTTL > 0 ? message : "";
  ui["hold-text"].textContent = mode === "charging" ? "松手起跳" : mode === "flight" ? "跳跃中" : "长按蓄力";
  ui.hold.setAttribute("aria-disabled", mode === "flight" ? "true" : "false");
  ui.meter.setAttribute("aria-valuenow", String(value));
  ui["meter-fill"].style.transform = "scaleX(" + value / 100 + ")";
  ui.mute.setAttribute("aria-pressed", String(muted));
  ui.mute.setAttribute("aria-label", muted ? "开启音效" : "关闭音效");
  if (mode === "over") ui["result-copy"].textContent = (state.newRecord ? "刷新纪录 · " : "本局 ") + score + " 分";
}

function awakenAudio() {
  if (muted) return;
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  try {
    if (!audio) audio = new Audio();
    if (audio.state === "suspended") audio.resume().catch(() => {});
  } catch { /* Audio is optional. */ }
}

function tone(notes) {
  if (!audio || audio.state !== "running" || muted) return;
  for (const [hz, delay, seconds, gain] of notes) {
    const time = audio.currentTime + delay;
    const voice = audio.createOscillator();
    const level = audio.createGain();
    voice.type = "sine";
    voice.frequency.setValueAtTime(hz, time);
    voice.frequency.exponentialRampToValueAtTime(hz * .91, time + seconds);
    level.gain.setValueAtTime(.0001, time);
    level.gain.exponentialRampToValueAtTime(gain, time + .018);
    level.gain.exponentialRampToValueAtTime(.0001, time + seconds);
    voice.connect(level).connect(audio.destination);
    voice.start(time);
    voice.stop(time + seconds);
  }
}

function start() {
  awakenAudio();
  reset("ready");
  ui.hold.focus({ preventScroll: true });
  tone([[560, 0, .12, .06], [750, .075, .16, .05]]);
}

function beginCharge(source) {
  if (state.mode !== "ready" || input !== null) return false;
  awakenAudio();
  input = source;
  state.mode = "charging";
  state.charge = 0;
  state.land = 0;
  syncUI();
  return true;
}

function cancelCharge() {
  input = null;
  if (state.mode === "charging") {
    state.mode = "ready";
    state.charge = 0;
    syncUI();
  }
}

function release(source) {
  if (state.mode !== "charging" || input !== source) return;
  input = null;
  const here = state.platforms[state.step];
  const next = state.platforms[state.step + 1];
  const right = next.x > here.x;
  const distance = distanceFromCharge(state.charge);
  state.turn = right ? "right" : "left";
  state.jump = {
    x: state.x, y: state.y,
    endX: state.x + (right ? distance : 0),
    endY: state.y + (right ? 0 : distance),
    time: .43 + .25 * (distance / maxDistance), lift: 60 + .24 * distance,
  };
  state.charge = 0;
  state.elapsed = 0;
  state.mode = "flight";
  burst(state.x, state.y, 10, false);
  tone([[435, 0, .13, .045], [680, .045, .10, .035]]);
  syncUI();
}

function land() {
  const next = state.platforms[state.step + 1];
  const offset = Math.max(Math.abs(next.x - state.x), Math.abs(next.y - state.y));
  if (offset > next.half - 4) {
    state.mode = "drop";
    state.elapsed = 0;
    state.z = 0;
    tone([[180, 0, .27, .04]]);
    return;
  }
  const precise = offset <= next.half * .23;
  state.step++;
  state.total++;
  state.score += precise ? 2 : 1;
  if (state.score > record) {
    state.newRecord = true;
    record = state.score;
    saveSetting("best", record);
  }
  state.land = .43;
  state.message = precise ? "精准落地 +2" : "+1";
  state.messageTTL = .95;
  // Ease the slide from the contact point to the center of the pad.
  state.settleX = state.x - next.x;
  state.settleY = state.y - next.y;
  state.x = next.x;
  state.y = next.y;
  state.z = 0;
  state.mode = "ready";
  const upcoming = state.platforms[state.step + 1];
  state.turn = upcoming.x > next.x ? "right" : "left";
  burst(state.x, state.y, precise ? 21 : 13, precise);
  tone(precise ? [[780, 0, .18, .065], [1050, .049, .21, .045]]
    : [[630, 0, .16, .06], [865, .073, .15, .04]]);
  addPlatform(state.platforms, state.total + state.platforms.length - state.step);
  if (state.step > 2) {
    state.platforms.shift();
    state.step--;
  }
}

function burst(x, y, count, bright) {
  const rand = makeRandom(Math.round(clock * 1e5) + count);
  for (let i = 0; i < count; i++) {
    const radius = rand() * 25;
    const angle = rand() * Math.PI * 2;
    particles.push({
      x: x + Math.cos(angle) * radius, y: y + Math.sin(angle) * radius,
      z: 2 + rand() * 8, vx: Math.cos(angle) * lerp(18, 92, rand()),
      vy: Math.sin(angle) * lerp(18, 92, rand()), vz: lerp(38, 112, rand()),
      age: 0, duration: lerp(.27, .69, rand()), radius: lerp(1.6, 4.9, rand()), bright,
    });
  }
}

function update(dt) {
  clock += dt;
  state.messageTTL = Math.max(0, state.messageTTL - dt);
  state.land = Math.max(0, state.land - dt);
  switch (state.mode) {
    case "charging":
      state.charge = Math.min(chargeLimit, state.charge + dt);
      break;
    case "flight": {
      state.elapsed += dt;
      const { jump } = state;
      const t = clamp(state.elapsed / jump.time);
      state.x = lerp(jump.x, jump.endX, t);
      state.y = lerp(jump.y, jump.endY, t);
      state.z = jump.lift * 4 * t * (1 - t);
      if (t === 1) land();
      break;
    }
    case "drop":
      state.elapsed += dt;
      state.z = -455 * state.elapsed ** 2;
      if (state.elapsed >= .65) {
        state.mode = "over";
        ui.retry.hidden = false;
        syncUI();
        ui.retry.focus({ preventScroll: true });
      }
      break;
  }
  for (const p of particles) {
    p.age += dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += p.vz * dt;
    p.vz -= 220 * dt;
  }
  particles = particles.filter((p) => p.age < p.duration && p.z >= -1);
  camera(dt);
}

function camera(dt, snap = false) {
  if (!state.platforms) return;
  const here = state.platforms[state.step];
  const next = state.platforms[state.step + 1];
  const intro = state.mode === "intro";
  const sign = next.x > here.x ? 1 : -1;
  const follow = state.mode === "flight" ? .27 : 0;
  const targetX = lerp(here.x, state.x, follow);
  const targetY = lerp(here.y, state.y, follow);
  const offsetX = intro ? width * (mobileLayout ? .38 : .58) : width * .50 - sign * Math.min(width * .125, 92);
  const offsetY = height * (intro && mobileLayout ? .53 : .64);
  const k = snap || reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 8);
  screen.x = lerp(screen.x, targetX, k);
  screen.y = lerp(screen.y, targetY, k);
  screen.anchorX = lerp(screen.anchorX, offsetX, k);
  screen.anchorY = lerp(screen.anchorY, offsetY, k);
}

function project(x, y, z = 0) {
  const a = x - screen.x;
  const b = y - screen.y;
  return {
    x: screen.anchorX + (a - b) * .84 * scale,
    y: screen.anchorY - ((a + b) * .40 + z) * scale,
  };
}

function polygon(g, points, fill, stroke, lineWidth = 1) {
  g.beginPath();
  g.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) g.lineTo(x, y);
  g.closePath();
  if (fill) {
    g.fillStyle = fill;
    g.fill();
  }
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = lineWidth;
    g.stroke();
  }
}

function gradient(g, x0, y0, x1, y1, stops) {
  const ink = g.createLinearGradient(x0, y0, x1, y1);
  for (const [at, color] of stops) ink.addColorStop(at, color);
  return ink;
}

function glimmer(g, x, y, r, color, opacity = 1) {
  g.save();
  g.globalAlpha *= opacity;
  polygon(g, [[x, y - r * 1.45], [x + r * .24, y - r * .21], [x + r, y],
    [x + r * .24, y + r * .22], [x, y + r * 1.42], [x - r * .24, y + r * .22],
    [x - r, y], [x - r * .24, y - r * .21]], color);
  g.restore();
}

function aurora(layer, shift, color, widthFactor) {
  const y = height * shift;
  bg.beginPath();
  bg.moveTo(-width * .13, y + height * .08);
  bg.bezierCurveTo(width * .14, y - 20, width * .32, y + height * .04, width * .51, y - height * .09);
  bg.bezierCurveTo(width * .69, y - height * .19, width * .76, y - height * .07, width * 1.10, y - height * .19);
  const ink = gradient(bg, 0, 0, width, 0, [[0, "transparent"], [.17, color], [.59, color], [.98, "transparent"]]);
  bg.lineWidth = height * widthFactor;
  bg.strokeStyle = ink;
  bg.shadowBlur = layer;
  bg.shadowColor = color;
  bg.stroke();
  bg.shadowBlur = 0;
}

function mountains(rand, base, peaks, amplitude, fill, snow) {
  const dx = width / peaks;
  const points = [[-dx, height]];
  for (let i = -1; i <= peaks; i++) {
    const low = base + lerp(-.044, .045, rand()) * height;
    const high = low - lerp(.37, 1, rand()) * amplitude;
    const x = i * dx;
    points.push([x, low], [x + dx * .54, high], [x + dx, low]);
  }
  points.push([width + dx, height]);
  polygon(bg, points, fill);
  if (snow) {
    for (let i = 1; i < points.length - 3; i += 3) {
      const left = points[i];
      const top = points[i + 1];
      const right = points[i + 2];
      const a = [lerp(top[0], left[0], .35), lerp(top[1], left[1], .35)];
      const b = [lerp(top[0], right[0], .36), lerp(top[1], right[1], .36)];
      polygon(bg, [a, top, b, [lerp(a[0], b[0], .58), Math.max(a[1], b[1]) + height * .012]], snow);
    }
  }
}

function paintBackground() {
  bg.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  bg.fillStyle = gradient(bg, 0, 0, width * .12, height, [
    [0, "#0a1940"], [.35, "#263b78"], [.64, "#657fba"], [.89, "#99c6de"], [1, "#b8deed"],
  ]);
  bg.fillRect(0, 0, width, height);
  const rand = makeRandom(4962);
  const mist = bg.createRadialGradient(width * .61, height * .56, 0, width * .61, height * .56, width * .62);
  mist.addColorStop(0, "#bceeff65");
  mist.addColorStop(.50, "#8b9ade2c");
  mist.addColorStop(1, "#7085d600");
  bg.fillStyle = mist;
  bg.fillRect(0, 0, width, height);
  aurora(35, .29, "#69e8f51f", .14);
  aurora(23, .34, "#7db8f42f", .088);
  aurora(10, .27, "#9ef6fa30", .018);
  aurora(20, .39, "#b694ff25", .068);
  for (let i = 0; i < 100; i++) {
    const x = rand() * width;
    const y = rand() * height * .56;
    if (i < 9) {
      glimmer(bg, x, y, lerp(2, 5, rand()), "#c8ecff", lerp(.22, .69, rand()));
    } else {
      bg.fillStyle = "rgba(216,242,255," + lerp(.09, .61, rand()) + ")";
      bg.beginPath();
      bg.arc(x, y, lerp(.5, 1.45, rand()), 0, Math.PI * 2);
      bg.fill();
    }
  }
  mountains(rand, height * .68, mobileLayout ? 7 : 13, height * .25,
    gradient(bg, 0, height * .39, 0, height, [[0, "#607eab85"], [.47, "#bfd5ef69"], [1, "#dceffc5c"]]), "#d8eef938");
  mountains(rand, height * .80, mobileLayout ? 6 : 10, height * .19,
    gradient(bg, 0, height * .50, 0, height, [[0, "#435d9188"], [.67, "#bfdcef72"], [1, "#c6edf16c"]]), "#c0e9fb42");
  bg.fillStyle = gradient(bg, 0, height * .53, 0, height, [[0, "#bfe5fd00"], [.68, "#bfe6f82b"], [1, "#e1f9fc99"]]);
  bg.fillRect(0, height * .53, width, height * .47);
}

function resize() {
  const frame = stage.getBoundingClientRect();
  width = frame.width;
  height = frame.height;
  pixelRatio = Math.min(devicePixelRatio || 1, 2);
  mobileLayout = width <= 690;
  scale = Math.min(width / (mobileLayout ? 530 : 720), height / 770, 1.55);
  canvas.width = background.width = Math.max(1, Math.round(width * pixelRatio));
  canvas.height = background.height = Math.max(1, Math.round(height * pixelRatio));
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  paintBackground();
  camera(0, true);
  render();
}

function drawSnow() {
  const rand = makeRandom(5532);
  const t = reducedMotion.matches ? 0 : clock;
  for (let i = 0; i < 52; i++) {
    const x = ((rand() * width + Math.sin(t * .33 + i) * (4 + rand() * 14)) % width + width) % width;
    const y = (rand() * height + t * lerp(4, 17, rand())) % height;
    const r = lerp(.7, 2.5, rand());
    const alpha = lerp(.16, .62, rand());
    ctx.fillStyle = "rgba(235,251,255," + alpha + ")";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function padPoints(half, z = 0) {
  const corner = half * .20;
  return [[-half, -half + corner], [-half + corner, -half], [half - corner, -half],
    [half, -half + corner], [half, half - corner], [half - corner, half],
    [-half + corner, half], [-half, half - corner]].map(([x, y]) => [
    (x - y) * .84 * scale, (-(x + y) * .40 - z) * scale,
  ]);
}

function drawPlatform(pad, kind, number, distanceAhead) {
  const q = project(pad.x, pad.y);
  if (q.x < -220 * scale || q.x > width + 220 * scale || q.y < -160 * scale || q.y > height + 220 * scale) return;
  const d = pad.depth * scale;
  const half = pad.half;
  const top = padPoints(half);
  const base = top.map(([x, y], i) => [x * (.69 + (i % 2) * .05), y * .79 + d * (.81 + (i % 3) * .10)]);
  const target = kind === "target";
  ctx.save();
  ctx.translate(q.x, q.y);
  if (kind === "old") ctx.globalAlpha = .56;
  if (kind === "far") ctx.globalAlpha = Math.max(.15, .70 - (distanceAhead - 2) * .13);
  const halo = ctx.createRadialGradient(0, d * .63, 0, 0, d * .60, half * 2.2 * scale);
  halo.addColorStop(0, target ? "#76f4ff4f" : "#3c87d335");
  halo.addColorStop(1, "#66beff00");
  ctx.fillStyle = halo;
  ctx.fillRect(-half * 2.2 * scale, -d, half * 4.4 * scale, d * 3);
  for (const i of [7, 0, 1, 2, 3]) {
    const j = (i + 1) % 8;
    const cool = i < 1 || i === 7;
    const side = gradient(ctx, 0, -18 * scale, 0, d, cool
      ? [[0, "#94d9f2"], [.25, "#5d99dc"], [1, "#255795"]]
      : [[0, "#b4f4fb"], [.35, "#59b4ea"], [1, "#3064a4"]]);
    polygon(ctx, [top[i], top[j], base[j], base[i]], side, "#bdedff52", .75);
    const facet = [lerp(base[i][0], base[j][0], .28), lerp(base[i][1], base[j][1], .31)];
    polygon(ctx, [top[i], top[j], facet], cool ? "#5d8dd55c" : "#6feaef66");
    const chip = [lerp(top[j][0], base[j][0], .42), lerp(top[j][1], base[j][1], .42)];
    polygon(ctx, [top[i], chip, facet], cool ? "#a0d1fe32" : "#4e8fd832");
  }
  const snow = gradient(ctx, -half * scale, -half * scale, half * scale, half * scale,
    target ? [[0, "#f3ffff"], [.45, "#d7fdff"], [1, "#7de0f7"]]
      : [[0, "#f1f8ff"], [.53, "#c6eaff"], [1, "#8dc5eb"]]);
  polygon(ctx, top, snow, target ? "#eeffff" : "#e4f9ff", target ? 2.1 : 1.25);
  const rim = padPoints(half * .86, .65);
  polygon(ctx, rim, "#e7ffff1f", target ? "#fbffffd7" : "#ecfdff90", .9);
  const rand = makeRandom(1007 + number * 63);
  for (let i = 0; i < 6; i++) {
    const x = lerp(-half, half, rand()) * .91 * scale;
    const y = lerp(-half * .23, half * .25, rand()) * scale;
    const l = lerp(8, 15, rand()) * scale;
    polygon(ctx, [[x, y], [x + l, y - 3 * scale], [x + l * .75, y + 4 * scale]],
      i % 2 ? "#ffffff82" : "#55b9e126");
  }
  if (target) {
    const pulse = reducedMotion.matches ? .83 : .72 + Math.sin(clock * 3.2) * .13;
    ctx.fillStyle = "#326d9524";
    ctx.strokeStyle = "rgba(26,138,190," + pulse + ")";
    ctx.lineWidth = Math.max(1, 1.65 * scale);
    ctx.beginPath();
    ctx.ellipse(0, 0, half * .57 * scale, half * .274 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.setLineDash([4.5 * scale, 5 * scale]);
    ctx.strokeStyle = "#faffffee";
    ctx.ellipse(0, 0, half * .69 * scale, half * .33 * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    glimmer(ctx, 0, 0, 8.4 * scale, "#f8ffff");
    glimmer(ctx, half * .91 * scale, -half * .49 * scale, 5.5 * scale, "#e9ffff", pulse);
  }
  ctx.restore();
}

function drawAvatar() {
  const { mode, x, y, z, charge } = state;
  if (mode === "over") return;
  const slide = reducedMotion.matches ? 0 : clamp((state.land - .27) / .16) ** 2;
  const foot = project(x + state.settleX * slide, y + state.settleY * slide, z);
  const floor = project(x + state.settleX * slide, y + state.settleY * slide);
  const size = 214 * scale;
  const progress = clamp(charge / chargeLimit);
  const jump = mode === "flight";
  const falling = mode === "drop";
  const isIntro = mode === "intro";
  const anticipation = mode === "charging" ? .17 * progress : state.land * .16;
  const bob = reducedMotion.matches || jump || falling ? 0 : Math.sin(clock * 3.05) * 1.9 * scale;
  ctx.save();
  ctx.translate(floor.x, floor.y);
  ctx.fillStyle = "rgba(25,75,137," + (.24 - clamp(z / 250, 0, .18)) + ")";
  ctx.beginPath();
  ctx.ellipse(0, 1.6 * scale, 44 * scale * (1 + clamp(z / 320, 0, .8)), 12 * scale, 0, 0, Math.PI * 2);
  if (!falling) ctx.fill();
  if (mode === "charging") {
    ctx.beginPath();
    ctx.strokeStyle = "rgba(215,254,255," + (.36 + progress * .63) + ")";
    ctx.lineWidth = 1.5 + 2 * progress;
    ctx.ellipse(0, -2 * scale, (46 + progress * 14) * scale, (14 + progress * 4) * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const wave = (clock * 1.7 + i / 4) % 1;
      glimmer(ctx, Math.cos(i * 1.6 + clock) * 53 * scale, (-9 - wave * 34) * scale,
        (2 + progress * 4) * scale, "#c0fdff", (1 - wave) * progress);
    }
  }
  ctx.restore();
  const pose = jump || falling ? "air" : state.land > .16 ? "joy" : "idle";
  const key = state.turn + "-" + pose;
  const frame = window.characterFrames[key];
  const uplift = isIntro && !reducedMotion.matches ? bob - scale * 2 : bob;
  ctx.save();
  ctx.translate(foot.x, foot.y + uplift);
  if (falling) {
    ctx.rotate(state.elapsed * (state.turn === "right" ? 1.9 : -1.9));
    ctx.globalAlpha = 1 - clamp(state.elapsed / .68);
  }
  if (atlas.complete && atlas.naturalWidth && frame) {
    const [ox, oy, w, h, ax, ay] = frame;
    const zoom = size / h;
    ctx.scale(1 + anticipation * .56, 1 - anticipation);
    ctx.drawImage(atlas, ox, oy, w, h, -ax * zoom, -ay * zoom, w * zoom, h * zoom);
  } else if (!ui["start-btn"].disabled) {
    ctx.beginPath();
    ctx.fillStyle = "#eaf7ff";
    ctx.ellipse(0, -38 * scale, 31 * scale, 38 * scale, 0, 0, Math.PI * 2);
    ctx.fill();
    glimmer(ctx, 0, -78 * scale, 15 * scale, "#72e5ff");
  }
  ctx.restore();
}

function render() {
  if (!state.platforms || width < 1 || height < 1) return;
  ctx.drawImage(background, 0, 0, width, height);
  drawSnow();
  for (let i = Math.min(state.platforms.length - 1, state.step + 6); i >= 0; i--) {
    const kind = i === state.step + 1 ? "target" : i === state.step ? "current" : i < state.step ? "old" : "far";
    drawPlatform(state.platforms[i], kind, state.total + i - state.step, i - state.step);
  }
  drawAvatar();
  for (const p of particles) {
    const q = project(p.x, p.y, p.z);
    glimmer(ctx, q.x, q.y, p.radius * scale, p.bright ? "#fff6a7" : "#d4fbff", 1 - p.age / p.duration);
  }
  syncUI();
}

function tick(now) {
  const dt = Math.min(.04, Math.max(0, (now - previousFrame) / 1000));
  previousFrame = now;
  if (!externalClock) {
    update(dt);
    render();
  }
  requestAnimationFrame(tick);
}

function stepTime(milliseconds) {
  externalClock = true;
  let time = clamp(Number(milliseconds) || 0, 0, 2000) / 1000;
  while (time > 1e-6) {
    const dt = Math.min(time, 1 / 120);
    update(dt);
    time -= dt;
  }
  render();
}

function renderGameToText() {
  const round = (x) => Math.round(x * 100) / 100;
  const targets = state.platforms.slice(state.step, state.step + 3);
  return JSON.stringify({
    game: "冰晶跳跳",
    coordinates: "x 轴向右上，y 轴向左上，z 轴为离开冰台的高度，单位为游戏内距离",
    mode: state.mode, score: state.score, record, landed: state.total, muted,
    player: { x: round(state.x), y: round(state.y), z: round(state.z), direction: state.turn },
    charge: { ms: Math.round(state.charge * 1000), maxMs: chargeLimit * 1000, jumpDistance: round(distanceFromCharge(state.charge)) },
    current: targets[0], next: targets[1], afterNext: targets[2],
    spriteReady: atlas.complete && atlas.naturalWidth > 0,
  });
}

function pointerDown(event) {
  if (event.button !== 0 || !event.isPrimary) return;
  if (event.target !== canvas && !event.target.closest("#hold")) return;
  if (!beginCharge(event.pointerId)) return;
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
}

stage.addEventListener("pointerdown", pointerDown);
stage.addEventListener("pointerup", (event) => release(event.pointerId));
stage.addEventListener("pointercancel", (event) => { if (event.pointerId === input) cancelCharge(); });
stage.addEventListener("lostpointercapture", (event) => { if (event.pointerId === input) cancelCharge(); });
stage.addEventListener("contextmenu", (event) => {
  if (event.target === canvas || event.target.closest("#hold")) event.preventDefault();
});

ui["start-btn"].addEventListener("click", start);
ui.retry.addEventListener("click", start);
ui.mute.addEventListener("click", () => {
  muted = !muted;
  saveSetting("mute", muted);
  if (!muted) {
    awakenAudio();
    tone([[750, 0, .17, .055]]);
  }
  syncUI();
});

const canFullscreen = Boolean(document.fullscreenEnabled && stage.requestFullscreen);
ui.fullscreen.hidden = !canFullscreen;

function toggleFullscreen() {
  if (!canFullscreen) return;
  const change = document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen();
  change.catch(() => {});
}

ui.fullscreen.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", resize);
window.addEventListener("keydown", (event) => {
  if (event.code === "KeyF" && !event.repeat) {
    toggleFullscreen();
    return;
  }
  if (event.code !== "Space") return;
  if (event.target.closest?.("button") && event.target !== ui.hold) return;
  if (["ready", "charging", "flight"].includes(state.mode)) event.preventDefault();
  if (!event.repeat) beginCharge("keyboard");
});
window.addEventListener("keyup", (event) => {
  if (event.code === "Space") release("keyboard");
});
window.addEventListener("blur", cancelCharge);
document.addEventListener("visibilitychange", () => { if (document.hidden) cancelCharge(); });
window.addEventListener("resize", resize, { passive: true });
window.advanceTime = stepTime;
window.render_game_to_text = renderGameToText;

function enableStart() {
  ui["start-btn"].disabled = false;
  render();
}
atlas.onload = enableStart;
atlas.onerror = enableStart;
atlas.src = window.characterAtlasUrl || "character.webp";

reset("intro");
resize();
requestAnimationFrame(tick);

