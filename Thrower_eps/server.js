const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const SIM_HZ = 60;                 // physics tick
const NET_HZ = 20;                 // broadcast tick
const SIM_DT = 1 / SIM_HZ;

const WORLD = { w: 960, h: 520, groundY: 450 };
const MID = WORLD.w / 2;

const LIMITS = {
  p1MinX: 30,
  p1MaxX: MID - 60,
  p2MinX: MID + 60,
  p2MaxX: WORLD.w - 30
};

const PLAYER = {
  w: 46,
  h: 56,
  accel: 42,
  maxSpeed: 260,
  friction: 16,
  gravity: 1600,
  jumpV: 560
};

const BALL = {
  r: 12,
  speedX: 520,
  speedY: 360,
  gravity: 1200,
  bounce: 0.55,
  dragX: 0.10
};

const SHIELD = {
  max: 3,
  regenDelayMs: 1400,
  regenTickMs: 700
};

const LASER = {
  warnMs: 2000,
  cooldownMs: 10000,
  // “so lang wie man springen kann” ~ flight time
  activeMs: Math.round((2 * PLAYER.jumpV / PLAYER.gravity) * 1000), // ~700ms
  thickness: 10
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function rectCircleHit(cx, cy, r, rx, ry, rw, rh) {
  const px = clamp(cx, rx, rx + rw);
  const py = clamp(cy, ry, ry + rh);
  const dx = cx - px, dy = cy - py;
  return dx * dx + dy * dy <= r * r;
}

function nowMs() { return Date.now(); }
function randId() { return Math.random().toString(36).slice(2, 10); }

function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// line-vs-rect with thickness (horizontal beam)
function beamHitsPlayer(beam, p) {
  const rx = p.x - PLAYER.w / 2;
  const ry = p.y - PLAYER.h;
  const rw = PLAYER.w;
  const rh = PLAYER.h;

  const y = beam.y;
  const halfT = LASER.thickness / 2;

  // check vertical overlap (beam as thick band)
  const yMin = ry;
  const yMax = ry + rh;
  if (y + halfT < yMin || y - halfT > yMax) return false;

  // segment x-range
  const x1 = beam.dir > 0 ? beam.x : 0;
  const x2 = beam.dir > 0 ? WORLD.w : beam.x;

  const segMin = Math.min(x1, x2);
  const segMax = Math.max(x1, x2);

  // rect x overlap
  const pxMin = rx;
  const pxMax = rx + rw;

  return !(segMax < pxMin || segMin > pxMax);
}

class Room {
  constructor(id) {
    this.id = id;
    this.clients = new Map(); // ws -> playerId
    this.score = { 1: 0, 2: 0 };
    this._eventSeq = 0;
    this._events = [];
    this.resetRound(true);
  }

  createPlayer(id, x, face) {
    return {
      id,
      x,
      y: WORLD.groundY,
      vx: 0,
      vy: 0,
      face,
      lives: 3,
      alive: true,

      shield: SHIELD.max,
      shieldNextRegenAt: 0,
      shieldNextTickAt: 0,

      cooldown: 0, // ball cooldown ticks

      // Laser cooldown
      laserCdUntil: 0,

      // input state
      inLeft: false,
      inRight: false,
      inThrow: false,
      inDeflect: false,
      inJump: false,
      inLaser: false,

      // edge
      prevJump: false,
      prevLaser: false,

      deflectActive: false,
    };
  }

  pushEvent(ev) {
    this._eventSeq += 1;
    this._events.push({ id: this._eventSeq, ...ev });
  }

  resetRound(fullReset) {
    this.roundOver = false;
    this.roundWinner = null;
    this.roundEndsAt = 0;

    this.players = {
      1: this.createPlayer(1, 160, 1),
      2: this.createPlayer(2, WORLD.w - 160, -1),
    };

    this.balls = [];
    this.lasers = []; // active beams

    this.pushEvent({ type: "round_start" });
  }

  hardResetMatch() {
    this.score = { 1: 0, 2: 0 };
    this.resetRound(true);
  }

  addClient(ws) {
    const taken = new Set(this.clients.values());
    let pid = null;

    if (!taken.has(1)) pid = 1;
    else if (!taken.has(2)) pid = 2;

    if (!pid) {
      ws.close();
      return null;
    }

    this.clients.set(ws, pid);

    safeSend(ws, {
      type: "join",
      roomId: this.id,
      playerId: pid,
      world: WORLD
    });

    this.broadcastLobby();
    return pid;
  }

  removeClient(ws) {
    this.clients.delete(ws);
    this.broadcastLobby();
  }

  broadcastLobby() {
    const list = [...this.clients.values()].sort();
    const msg = { type: "lobby", players: list };
    for (const ws of this.clients.keys()) safeSend(ws, msg);
  }

  onInput(pid, input) {
    const p = this.players[pid];
    if (!p) return;

    if (input.reset) {
      this.hardResetMatch();
      return;
    }

    p.inLeft = !!input.left;
    p.inRight = !!input.right;

    // Jump supports SPACE (+ optional W in client)
    p.inJump = !!input.jump;

    // Deflect (O)
    p.inDeflect = !!input.deflect;

    // Laser (I) - edge triggered
    p.inLaser = !!input.laser;

    // Ball throw (F) cannot happen while deflecting
    p.inThrow = !!input.throw && !p.inDeflect;
  }

  // ---- Ball ----
  spawnBall(ownerId, x, y, face) {
    this.balls.push({
      owner: ownerId,
      x,
      y,
      vx: face * BALL.speedX,
      vy: -BALL.speedY * 0.6,
      r: BALL.r,
      alive: true,
      bornAt: nowMs()
    });
  }

  tryThrow(p) {
    if (this.roundOver || !p.alive) return;
    if (p.deflectActive) return;
    if (p.cooldown > 0) return;

    const sx = p.x + p.face * (PLAYER.w / 2 + BALL.r + 6);
    const sy = p.y - PLAYER.h + 18;

    this.spawnBall(p.id, sx, sy, p.face);
    p.cooldown = 18; // 0.3s @60Hz
  }

  // ---- Shield regen ----
  applyShieldRegen(p, t) {
    if (p.shield >= SHIELD.max) return;
    if (t < p.shieldNextRegenAt) return;

    if (t >= p.shieldNextTickAt) {
      p.shield = Math.min(SHIELD.max, p.shield + 1);
      p.shieldNextTickAt = t + SHIELD.regenTickMs;
      this.pushEvent({ type: "shield_regen", pid: p.id, shield: p.shield });
    }
  }

  damageShield(p, t) {
    if (p.shield <= 0) return false;

    p.shield = Math.max(0, p.shield - 1);
    p.shieldNextRegenAt = t + SHIELD.regenDelayMs;
    p.shieldNextTickAt = p.shieldNextRegenAt;
    return true;
  }

  // ---- Lives / KO ----
  hitPlayer(target, attackerId, hitX, hitY, source) {
    target.lives -= 1;
    this.pushEvent({ type: "hit", pid: target.id, by: attackerId, x: hitX, y: hitY, lives: target.lives, src: source });

    if (target.lives <= 0) {
      target.alive = false;
      this.score[attackerId] += 1;

      this.roundOver = true;
      this.roundWinner = attackerId;
      this.roundEndsAt = nowMs() + 1800;

      this.pushEvent({ type: "ko", loser: target.id, winner: attackerId, x: hitX, y: hitY, src: source });
    }
  }

  // ---- Laser ----
  startLaser(p) {
    const t = nowMs();
    if (this.roundOver || !p.alive) return;
    if (p.deflectActive) return; // cannot start laser while deflecting
    if (t < p.laserCdUntil) return;

    // only one laser per player at a time
    if (this.lasers.some(L => L.alive && L.owner === p.id)) return;

    const beam = {
      owner: p.id,
      x: p.x,
      y: p.y - PLAYER.h / 2,
      dir: p.face > 0 ? 1 : -1,
      phase: "warn", // "warn" -> "active"
      warnEndsAt: t + LASER.warnMs,
      activeEndsAt: 0,
      alive: true,
      hit1: false,
      hit2: false,
      reflected: false
    };

    this.lasers.push(beam);
    p.laserCdUntil = t + LASER.cooldownMs;

    this.pushEvent({ type: "laser_warn", pid: p.id, x: beam.x, y: beam.y });
  }

  activateLaser(beam) {
    const t = nowMs();
    beam.phase = "active";
    beam.activeEndsAt = t + LASER.activeMs;
    this.pushEvent({ type: "laser_active", owner: beam.owner });

    // “perfect deflect” only at the moment it turns red (activation tick)
    const shooter = this.players[beam.owner];
    const target = this.players[beam.owner === 1 ? 2 : 1];

    if (!target.alive) return;

    const hitTarget = beamHitsPlayer(beam, target);

    if (hitTarget && target.deflectActive && target.shield > 0) {
      // reflect
      this.damageShield(target, t);
      beam.owner = target.id;
      beam.dir *= -1;
      beam.x = target.x;               // reflect point
      beam.y = target.y - PLAYER.h / 2;
      beam.reflected = true;

      // reset hit flags so it can hit the other player
      beam.hit1 = false;
      beam.hit2 = false;

      this.pushEvent({ type: "laser_reflect", by: target.id, x: beam.x, y: beam.y });

      // after reflect, try immediate hit on new target (the old shooter) during active window
      const newTarget = this.players[beam.owner === 1 ? 2 : 1];
      if (newTarget.alive && beamHitsPlayer(beam, newTarget)) {
        this.applyLaserDamageOnce(beam, newTarget);
      }
    } else {
      // no reflect; laser may hit normally during active window
      if (hitTarget) this.applyLaserDamageOnce(beam, target);
    }
  }

  applyLaserDamageOnce(beam, target) {
    // only hit once per player per laser activation
    if (target.id === 1 && beam.hit1) return;
    if (target.id === 2 && beam.hit2) return;

    const t = nowMs();

    // if target deflecting + shield available, it blocks (but only reflect happens at activation moment)
    if (target.deflectActive && target.shield > 0) {
      this.damageShield(target, t);
      this.pushEvent({ type: "laser_block", pid: target.id, x: target.x, y: target.y - PLAYER.h / 2, shield: target.shield });
      if (target.id === 1) beam.hit1 = true;
      else beam.hit2 = true;
      return;
    }

    // deal damage
    this.hitPlayer(target, beam.owner, target.x, target.y - PLAYER.h / 2, "laser");
    if (target.id === 1) beam.hit1 = true;
    else beam.hit2 = true;
  }

  // ---- Main Tick ----
  tick() {
    const t = nowMs();
    const p1 = this.players[1];
    const p2 = this.players[2];

    // next round after pause
    if (this.roundOver && t >= this.roundEndsAt) {
      this.resetRound(true);
      return;
    }

    // players
    for (const p of [p1, p2]) {
      if (!p.alive) continue;

      // deflect state (held)
      p.deflectActive = p.inDeflect;

      // shield regen
      this.applyShieldRegen(p, t);

      // movement
      const ax = PLAYER.accel * SIM_DT * 1000;
      const fr = PLAYER.friction * SIM_DT * 1000;
      const maxV = PLAYER.maxSpeed;

      if (!this.roundOver) {
        if (p.inLeft) p.vx -= ax;
        if (p.inRight) p.vx += ax;
      } else {
        p.vx *= 0.85;
      }

      if (!p.inLeft && !p.inRight) {
        if (p.vx > 0) p.vx = Math.max(0, p.vx - fr);
        else if (p.vx < 0) p.vx = Math.min(0, p.vx + fr);
      }

      p.vx = clamp(p.vx, -maxV, maxV);
      p.x += p.vx * SIM_DT;

      // clamp per side
      if (p.id === 1) p.x = clamp(p.x, LIMITS.p1MinX, LIMITS.p1MaxX);
      if (p.id === 2) p.x = clamp(p.x, LIMITS.p2MinX, LIMITS.p2MaxX);

      // face from velocity
      if (p.vx > 5) p.face = 1;
      else if (p.vx < -5) p.face = -1;

      // jump edge-trigger
      const jumpPressed = p.inJump && !p.prevJump;
      p.prevJump = p.inJump;

      if (!this.roundOver && jumpPressed && p.y >= WORLD.groundY - 0.001) {
        p.vy = -PLAYER.jumpV;
      }

      // gravity
      p.vy += PLAYER.gravity * SIM_DT;
      p.y += p.vy * SIM_DT;

      if (p.y >= WORLD.groundY) {
        p.y = WORLD.groundY;
        p.vy = 0;
      }

      // ball throw
      if (!this.roundOver && p.inThrow) this.tryThrow(p);

      // laser edge trigger
      const laserPressed = p.inLaser && !p.prevLaser;
      p.prevLaser = p.inLaser;
      if (laserPressed) this.startLaser(p);

      // cooldown tick
      p.cooldown = Math.max(0, p.cooldown - 1);
    }

    // balls
    for (const b of this.balls) {
      if (!b.alive) continue;

      b.vy += BALL.gravity * SIM_DT;
      b.x += b.vx * SIM_DT;
      b.y += b.vy * SIM_DT;

      // bounce
      if (b.y + b.r >= WORLD.groundY) {
        b.y = WORLD.groundY - b.r;
        b.vy = -b.vy * BALL.bounce;
        b.vx *= (1 - BALL.dragX);
        if (Math.abs(b.vy) < 120 && Math.abs(b.vx) < 120) {
          b.alive = false;
          continue;
        }
      }

      // out
      if (b.x < -80 || b.x > WORLD.w + 80 || b.y > WORLD.h + 200) {
        b.alive = false;
        continue;
      }

      const target = this.players[b.owner === 1 ? 2 : 1];
      if (!target.alive) continue;

      const rx = target.x - PLAYER.w / 2;
      const ry = target.y - PLAYER.h;

      if (rectCircleHit(b.x, b.y, b.r, rx, ry, PLAYER.w, PLAYER.h)) {
        const hitX = b.x, hitY = b.y;

        // deflect ball
        if (!this.roundOver && target.deflectActive && target.shield > 0) {
          this.damageShield(target, t);
          this.pushEvent({ type: "deflect", pid: target.id, x: hitX, y: hitY, shield: target.shield });

          b.owner = target.id;
          b.vx = -b.vx * 1.10;
          b.vy = -Math.abs(b.vy) * 0.70 - 180;

          const dir = target.id === 1 ? 1 : -1;
          b.x = target.x + dir * (PLAYER.w / 2 + b.r + 10);
          b.y = target.y - PLAYER.h / 2;
        } else {
          // normal hit
          b.alive = false;
          this.hitPlayer(target, b.owner, hitX, hitY, "ball");
        }
      }
    }

    this.balls = this.balls.filter(b => b.alive);

    // lasers
    for (const L of this.lasers) {
      if (!L.alive) continue;

      // keep beam anchored to owner while warning (so it follows player nicely)
      const ownerP = this.players[L.owner];
      if (L.phase === "warn" && ownerP?.alive) {
        L.x = ownerP.x;
        L.y = ownerP.y - PLAYER.h / 2;
        L.dir = ownerP.face > 0 ? 1 : -1;
      }

      if (L.phase === "warn" && t >= L.warnEndsAt) {
        this.activateLaser(L);
      }

      if (L.phase === "active") {
        if (t >= L.activeEndsAt) {
          L.alive = false;
          continue;
        }

        // During active, apply damage once if intersects
        const target = this.players[L.owner === 1 ? 2 : 1];
        if (target.alive && beamHitsPlayer(L, target)) {
          this.applyLaserDamageOnce(L, target);
        }
      }
    }

    this.lasers = this.lasers.filter(L => L.alive);
  }

  snapshotAndBroadcast() {
    const p1 = this.players[1];
    const p2 = this.players[2];

    const snap = {
      type: "state",
      t: nowMs(),
      score: this.score,
      roundOver: this.roundOver,
      roundWinner: this.roundWinner,

      p: {
        1: {
          x: p1.x, y: p1.y, face: p1.face,
          lives: p1.lives, shield: p1.shield,
          def: p1.deflectActive, cd: p1.cooldown,
          alive: p1.alive,
          lcd: Math.max(0, p1.laserCdUntil - nowMs())
        },
        2: {
          x: p2.x, y: p2.y, face: p2.face,
          lives: p2.lives, shield: p2.shield,
          def: p2.deflectActive, cd: p2.cooldown,
          alive: p2.alive,
          lcd: Math.max(0, p2.laserCdUntil - nowMs())
        }
      },

      b: this.balls.map(bb => ({ o: bb.owner, x: bb.x, y: bb.y, r: bb.r })),

      // lasers minimal
      lz: this.lasers.map(L => ({
        o: L.owner,
        x: L.x,
        y: L.y,
        dir: L.dir,
        ph: L.phase,
        we: L.warnEndsAt,
        ae: L.activeEndsAt,
        rf: !!L.reflected
      })),

      e: this._events
    };

    this._events = [];

    for (const ws of this.clients.keys()) safeSend(ws, snap);
  }
}

const rooms = new Map();
function getOrCreateRoom() {
  if (!rooms.has("main")) rooms.set("main", new Room("main"));
  return rooms.get("main");
}

wss.on("connection", (ws) => {
  const room = getOrCreateRoom();
  const pid = room.addClient(ws);

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "input" && pid) room.onInput(pid, msg.input || {});
  });

  ws.on("close", () => room.removeClient(ws));
});

setInterval(() => {
  for (const room of rooms.values()) room.tick();
}, 1000 / SIM_HZ);

setInterval(() => {
  for (const room of rooms.values()) room.snapshotAndBroadcast();
}, 1000 / NET_HZ);

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
