const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");

const roomEl = document.getElementById("room");
const youEl = document.getElementById("you");
const lobbyEl = document.getElementById("lobby");
const statusEl = document.getElementById("status");

const s1 = document.getElementById("s1");
const s2 = document.getElementById("s2");
const l1 = document.getElementById("l1");
const l2 = document.getElementById("l2");
const sh1 = document.getElementById("sh1");
const sh2 = document.getElementById("sh2");
const cd1 = document.getElementById("cd1");
const cd2 = document.getElementById("cd2");

const W = canvas.width;
const H = canvas.height;

let myId = null;
let world = { w: 960, h: 520, groundY: 450 };

// --- assets ---
const avatar1 = new Image(); avatar1.src = "/avatars/p1.png";
const avatar2 = new Image(); avatar2.src = "/avatars/p2.png";
const ballImg  = new Image(); ballImg.src  = "/avatars/ball.png";

// --- input ---
const keys = new Set();
addEventListener("keydown", (e) => {
  const k = e.key === " " ? "space" : e.key.toLowerCase();
  keys.add(k);
  if (e.key === " ") e.preventDefault();
});
addEventListener("keyup", (e) => {
  const k = e.key === " " ? "space" : e.key.toLowerCase();
  keys.delete(k);
});

// --- networking ---
function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}`;
}
const ws = new WebSocket(wsUrl());

ws.onopen = () => statusEl.textContent = "connected";
ws.onclose = () => statusEl.textContent = "disconnected";
ws.onerror = () => statusEl.textContent = "error";

// --- snapshots for interpolation ---
let snapA = null;
let snapB = null;

function setSnapshot(s) {
  snapA = snapB;
  snapB = s;
  if (!snapA) snapA = snapB;
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === "join") {
    myId = msg.playerId;
    youEl.textContent = `P${myId}`;
    roomEl.textContent = msg.roomId || "main";
    world = msg.world || world;
  }

  if (msg.type === "lobby") {
    lobbyEl.textContent = (msg.players || []).map(p => `P${p}`).join(", ") || "-";
  }

  if (msg.type === "state") {
    setSnapshot(msg);

    // HUD
    s1.textContent = msg.score[1];
    s2.textContent = msg.score[2];
    l1.textContent = msg.p[1].lives;
    l2.textContent = msg.p[2].lives;
    sh1.textContent = msg.p[1].shield;
    sh2.textContent = msg.p[2].shield;

    // laser cooldown (ms -> seconds)
    cd1.textContent = (msg.p[1].lcd / 1000).toFixed(1);
    cd2.textContent = (msg.p[2].lcd / 1000).toFixed(1);

    if (msg.roundOver) statusEl.textContent = `Player ${msg.roundWinner} wins!`;
    else statusEl.textContent = "fight!";

    // events -> effects
    if (Array.isArray(msg.e)) for (const e of msg.e) handleEvent(e);
  }
};

// --- input send (throttle + change detection) ---
let lastSent = 0;
let lastSig = "";

function buildInput() {
  const input = { left:false, right:false, jump:false, deflect:false, throw:false, laser:false, reset:false };

  // BOTH PLAYERS use same keys (online = per-client)
  input.left = keys.has("a");
  input.right = keys.has("d");

  // Jump: SPACE + (optional W alias)
  input.jump = keys.has("space") || keys.has("w");

  // Deflect: O
  input.deflect = keys.has("o");

  // Throw: F (cannot throw while deflect)
  input.throw = keys.has("f") && !input.deflect;

  // Laser: I (edge handled server-side)
  input.laser = keys.has("i") && !input.deflect;

  input.reset = keys.has("r");

  return input;
}

function sigOf(i) {
  return [
    i.left?1:0,
    i.right?1:0,
    i.jump?1:0,
    i.deflect?1:0,
    i.throw?1:0,
    i.laser?1:0,
    i.reset?1:0
  ].join("");
}

function sendInputTick() {
  if (ws.readyState !== 1 || !myId) return;

  const t = performance.now();
  if (t - lastSent < 33) return; // ~30Hz

  const input = buildInput();
  const sig = sigOf(input);

  const force = (t - lastSent) > 200;
  if (sig !== lastSig || force) {
    ws.send(JSON.stringify({ type: "input", input }));
    lastSig = sig;
    lastSent = t;
  }
}

// --- particles / effects ---
const particles = [];

function spawnBurst(x, y, count, strength) {
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = strength * (0.4 + Math.random() * 0.6);
    particles.push({
      x, y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.5,
      r: 2 + Math.random() * 3
    });
  }
}

function handleEvent(e) {
  if (e.type === "hit") spawnBurst(e.x, e.y, 18, 220);
  if (e.type === "deflect") spawnBurst(e.x, e.y, 10, 160);
  if (e.type === "ko") spawnBurst(e.x, e.y, 40, 300);
  if (e.type === "laser_reflect") spawnBurst(e.x, e.y, 26, 260);
}

// --- rendering ---
function lerp(a,b,t){ return a + (b-a)*t; }

function sampleInterpolatedState(nowMs) {
  if (!snapA || !snapB) return null;

  const tA = snapA.t;
  const tB = snapB.t;
  if (tB === tA) return snapB;

  const target = nowMs - 90; // render behind a bit
  const f = Math.max(0, Math.min(1, (target - tA) / (tB - tA)));

  const out = {
    p: {1:{},2:{}},
    b: [],
    lz: snapB.lz || [],
    score: snapB.score,
    roundOver: snapB.roundOver,
    roundWinner: snapB.roundWinner
  };

  for (const id of [1,2]) {
    const A = snapA.p[id];
    const B = snapB.p[id];
    out.p[id] = {
      x: lerp(A.x,B.x,f),
      y: lerp(A.y,B.y,f),
      face: B.face,
      lives: B.lives,
      shield: B.shield,
      def: B.def,
      alive: B.alive
    };
  }

  const aBalls = snapA.b || [];
  const bBalls = snapB.b || [];
  const n = Math.max(aBalls.length, bBalls.length);

  for (let i = 0; i < n; i++) {
    const A = aBalls[i] || bBalls[i];
    const B = bBalls[i] || aBalls[i];
    if (!A || !B) continue;
    out.b.push({
      o: B.o, r: B.r,
      x: lerp(A.x,B.x,f),
      y: lerp(A.y,B.y,f)
    });
  }

  return out;
}

function drawAvatar(img, x, y, w, h) {
  if (img.complete && img.naturalWidth) {
    ctx.drawImage(img, x - w/2, y - h, w, h);
  } else {
    ctx.fillRect(x - w/2, y - h, w, h);
  }
}

function drawLaser(beam, now) {
  const x = beam.x;
  const y = beam.y;
  const toX = beam.dir > 0 ? W : 0;

  if (beam.ph === "warn") {
    // white telegraph (clean)
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(toX, y);
    ctx.stroke();

    // soft white glow
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(toX, y);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // active red beam
  ctx.save();

  // inner core
  ctx.globalAlpha = 0.95;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(255,60,60,0.95)";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(toX, y);
  ctx.stroke();

  // glow
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 18;
  ctx.strokeStyle = "rgba(255,40,40,0.9)";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(toX, y);
  ctx.stroke();

  // extra glow for reflected (optional)
  if (beam.rf) {
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 26;
    ctx.strokeStyle = "rgba(255,120,120,0.9)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(toX, y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawWorld(s) {
  ctx.clearRect(0,0,W,H);

  // ground fixed
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  ctx.fillRect(0, world.groundY, W, H - world.groundY);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(0, world.groundY + 0.5);
  ctx.lineTo(W, world.groundY + 0.5);
  ctx.stroke();

  // mid line
  ctx.setLineDash([8,10]);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(W/2, 20);
  ctx.lineTo(W/2, world.groundY);
  ctx.stroke();
  ctx.setLineDash([]);

  // lasers (draw under players but above ground)
  const now = Date.now();
  for (const L of (s.lz || [])) {
    drawLaser(L, now);
  }

  // players
  const p1 = s.p[1], p2 = s.p[2];

  ctx.globalAlpha = p1.alive ? 1 : 0.25;
  drawAvatar(avatar1, p1.x, p1.y, 46, 56);

  if (p1.def && p1.shield > 0 && p1.alive) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p1.x, p1.y - 28, 28, 0, Math.PI*2);
    ctx.stroke();
  }

  ctx.globalAlpha = p2.alive ? 1 : 0.25;
  drawAvatar(avatar2, p2.x, p2.y, 46, 56);

  if (p2.def && p2.shield > 0 && p2.alive) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p2.x, p2.y - 28, 28, 0, Math.PI*2);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;

  // balls
  for (const b of s.b) {
    const size = b.r * 2;
    if (ballImg.complete && ballImg.naturalWidth) {
      ctx.drawImage(ballImg, b.x - b.r, b.y - b.r, size, size);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // particles
  const dt = 1/60;
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    p.vy += 520 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= 0.985;
    p.vy *= 0.985;

    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }

    ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI*2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function loop() {
  sendInputTick();
  const s = sampleInterpolatedState(Date.now());
  if (s) drawWorld(s);
  requestAnimationFrame(loop);
}
loop();
