/**
 * FloatNote · Canvas 2D 光效与粒子舞台
 *
 * 渲染时钟由外部传入（优先 AudioContext.currentTime），
 * 所有光效使用 radial / linear gradient 绘制，固定 screen 叠加。
 */

import { getInstrument } from './instruments.js';
import { midiToJianpu } from './scoreParser.js';
import {
  clamp,
  hexToRgb,
  hslToRgb,
  lerp,
  mapRange,
  midiToName,
  mixColors,
  prefersReducedMotion,
  rgbToHex,
  rgbToHsl,
  rgba,
} from './tools.js';

const POOL_SIZE = 1500;
const TAU = Math.PI * 2;

function isBlackKey(midi) {
  return [1, 3, 6, 8, 10].includes(((midi % 12) + 12) % 12);
}

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function makeGlowSprite(color, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const radius = size / 2;
  const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, rgba('#ffffff', 0.98));
  gradient.addColorStop(0.16, rgba(color, 0.9));
  gradient.addColorStop(0.48, rgba(color, 0.3));
  gradient.addColorStop(0.78, rgba(color, 0.08));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function makeSmokeSprite(color, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'screen';
  const puffs = [
    { x: 0.45, y: 0.48, r: 0.42, a: 0.42 },
    { x: 0.62, y: 0.4, r: 0.3, a: 0.3 },
    { x: 0.35, y: 0.6, r: 0.28, a: 0.22 },
  ];
  for (const puff of puffs) {
    const cx = size * puff.x;
    const cy = size * puff.y;
    const r = size * puff.r;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    gradient.addColorStop(0, rgba(color, puff.a));
    gradient.addColorStop(0.55, rgba(color, puff.a * 0.45));
    gradient.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}

export class StageRenderer {
  constructor(canvas, { clock = () => performance.now() / 1000 } = {}) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('StageRenderer 需要一个 canvas 元素');
    }
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true });
    if (!this.ctx) throw new Error('当前浏览器无法创建 Canvas 2D 上下文。');
    this.ctx.globalCompositeOperation = 'screen';
    this.clock = clock;
    this.reducedMotion = prefersReducedMotion();

    this.dpr = 1;
    this.width = 0;
    this.height = 0;
    this.lastClock = 0;
    this.frameHandle = 0;
    this.running = false;

    this.instrument = getInstrument('piano');
    this.theme = {
      color: '#a9c4ee',
      brightness: 1,
      density: 1,
    };
    this.keyOffset = 0;
    this.timeSigNum = 4;
    this.timeSigDen = 4;

    this.transport = {
      beat: 0,
      playing: false,
      totalBeats: 0,
      barLength: 4,
      barIndex: 0,
      beatInBar: 0,
      ab: { a: null, b: null },
      loopMode: 'off',
      metronome: false,
    };

    this.particles = Array.from({ length: POOL_SIZE }, () => ({ active: false }));
    this.particleCursor = 0;
    this.particleCount = 0;
    this.maxParticles = 900;
    this.pending = [];
    this.activeNotes = new Map();
    this.rings = [];
    this.smoke = [];
    this.sprites = {};
    this.smokeSprites = {};
    this.palette = {};

    this.resizeObserver = null;
    this.handleResize = this.handleResize.bind(this);
    this.tick = this.tick.bind(this);

    this.applyPalette();
    this.initSmoke();
    this.handleResize();
    this.bindResize();
  }

  /* -------------------------------------------------- setup */

  bindResize() {
    window.addEventListener('resize', this.handleResize, { passive: true });
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(this.handleResize);
      this.resizeObserver.observe(this.canvas);
    }
  }

  handleResize() {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    if (width === this.width && height === this.height && dpr === this.dpr) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.globalCompositeOperation = 'screen';
    this.initSmoke();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastClock = this.clock();
    this.frameHandle = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.resizeObserver?.disconnect();
    this.pending = [];
    this.activeNotes.clear();
  }

  resetClock() {
    this.lastClock = this.clock();
  }

  setInstrument(id) {
    this.instrument = getInstrument(id);
    this.applyPalette();
  }

  setTheme({ color, brightness, density }) {
    if (color) this.theme.color = color;
    if (Number.isFinite(brightness)) this.theme.brightness = clamp(brightness, 0.2, 2);
    if (Number.isFinite(density)) this.theme.density = clamp(density, 0.2, 2.2);
    this.maxParticles = Math.round(
      (this.reducedMotion ? 420 : 980) * clamp(this.theme.density, 0.35, 2)
    );
    this.applyPalette();
  }

  setScoreMeta({ keyOffset = 0, timeSigNum = 4, timeSigDen = 4, totalBeats = 0 }) {
    this.keyOffset = Number(keyOffset) || 0;
    this.timeSigNum = Number(timeSigNum) || 4;
    this.timeSigDen = Number(timeSigDen) || 4;
    this.transport.totalBeats = Math.max(0, Number(totalBeats) || 0);
    this.transport.barLength = this.timeSigNum;
  }

  setTransport(patch = {}) {
    Object.assign(this.transport, patch);
    if (patch.ab) this.transport.ab = { ...patch.ab };
  }

  setAB(ab) {
    this.transport.ab = {
      a: Number.isFinite(ab?.a) ? ab.a : null,
      b: Number.isFinite(ab?.b) ? ab.b : null,
    };
  }

  /* -------------------------------------------------- palette */

  applyPalette() {
    const primary = this.theme.color;
    const rgb = hexToRgb(primary) || { r: 169, g: 196, b: 238 };
    const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
    const secondary = rgbToHex(
      ...Object.values(
        hslToRgb(
          hsl.h + 34,
          clamp(hsl.s * 0.86, 0.08, 0.7),
          clamp(hsl.l + 0.08, 0.2, 0.92)
        )
      )
    );
    const highlight = mixColors(primary, '#ffffff', 0.58);
    const accentBase = mixColors(primary, this.instrument.color, 0.52);
    const accentHsl = rgbToHsl(
      ...Object.values(hexToRgb(accentBase) || { r: 150, g: 180, b: 225 })
    );
    const accent = rgbToHex(
      ...Object.values(
        hslToRgb(
          accentHsl.h,
          clamp(accentHsl.s + 0.18, 0.12, 0.82),
          clamp(accentHsl.l - 0.05, 0.2, 0.82)
        )
      )
    );
    const warm = mixColors(primary, '#f0c8c8', 0.38);

    this.palette = { primary, secondary, highlight, accent, warm, white: '#ffffff' };
    this.sprites = {
      primary: makeGlowSprite(primary),
      secondary: makeGlowSprite(secondary),
      highlight: makeGlowSprite(highlight),
      accent: makeGlowSprite(accent),
      white: makeGlowSprite('#ffffff'),
    };
    this.smokeSprites = {
      primary: makeSmokeSprite(primary),
      accent: makeSmokeSprite(accent),
      warm: makeSmokeSprite(warm),
    };
  }

  initSmoke() {
    const count = this.reducedMotion ? 3 : 5;
    this.smoke = Array.from({ length: count }, (_, index) => ({
      nx: 0.12 + Math.random() * 0.76,
      ny: 0.18 + Math.random() * 0.62,
      radius: 0.22 + Math.random() * 0.28,
      phase: Math.random() * TAU,
      speed: 0.02 + Math.random() * 0.035,
      alpha: 0.07 + Math.random() * 0.08,
      sprite: ['primary', 'accent', 'warm'][index % 3],
    }));
  }

  /* -------------------------------------------------- particles */

  spawnParticle(options) {
    if (this.particleCount >= this.maxParticles) return false;
    let particle = null;
    for (let step = 0; step < POOL_SIZE; step += 1) {
      const candidate = this.particles[(this.particleCursor + step) % POOL_SIZE];
      if (!candidate.active) {
        particle = candidate;
        this.particleCursor = (this.particleCursor + step + 1) % POOL_SIZE;
        break;
      }
    }
    if (!particle) return false;

    Object.assign(particle, {
      active: true,
      x: options.x,
      y: options.y,
      vx: options.vx ?? 0,
      vy: options.vy ?? 0,
      ax: options.ax ?? 0,
      ay: options.ay ?? 0,
      drag: options.drag ?? 0.985,
      age: 0,
      life: Math.max(0.08, options.life ?? 1),
      size: Math.max(0.6, options.size ?? 3),
      alpha: clamp(options.alpha ?? 0.6, 0, 1),
      sprite: options.sprite || 'primary',
      wobble: options.wobble ?? 0,
      seed: Math.random() * TAU,
      stretch: options.stretch ?? 1,
      angle: options.angle ?? 0,
    });
    this.particleCount += 1;
    return true;
  }

  updateParticles(dt, now) {
    for (const particle of this.particles) {
      if (!particle.active) continue;
      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.active = false;
        this.particleCount = Math.max(0, this.particleCount - 1);
        continue;
      }
      const drag = Math.pow(particle.drag, dt * 60);
      particle.vx = particle.vx * drag + particle.ax * dt;
      particle.vy = particle.vy * drag + particle.ay * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      if (particle.wobble) {
        particle.x += Math.sin((now + particle.seed) * particle.wobble) * dt * 9;
      }
      if (
        particle.x < -80 ||
        particle.x > this.width + 80 ||
        particle.y < -80 ||
        particle.y > this.height + 80
      ) {
        particle.active = false;
        this.particleCount = Math.max(0, this.particleCount - 1);
      }
    }
  }

  drawParticles() {
    const ctx = this.ctx;
    for (const particle of this.particles) {
      if (!particle.active) continue;
      const lifeT = 1 - particle.age / particle.life;
      const sprite = this.sprites[particle.sprite] || this.sprites.primary;
      if (!sprite) continue;
      const alpha = particle.alpha * Math.pow(lifeT, 0.72) * this.theme.brightness;
      if (alpha <= 0.003) continue;
      const size = particle.size * (0.68 + lifeT * 0.95);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      if (particle.stretch > 1 || particle.angle) {
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.angle);
        ctx.drawImage(
          sprite,
          (-size * particle.stretch) / 2,
          -size / 2,
          size * particle.stretch,
          size
        );
        ctx.restore();
      } else {
        ctx.drawImage(sprite, particle.x - size, particle.y - size, size * 2, size * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  ambientParticles(dt, now) {
    if (this.reducedMotion) return;
    const rate = 5 * this.theme.density;
    this.ambientAccumulator = (this.ambientAccumulator || 0) + dt * rate;
    while (this.ambientAccumulator >= 1) {
      this.ambientAccumulator -= 1;
      const high = Math.random() > 0.72;
      this.spawnParticle({
        x: Math.random() * this.width,
        y: this.height * (0.35 + Math.random() * 0.65),
        vx: (Math.random() - 0.5) * 8,
        vy: -(4 + Math.random() * 14),
        life: 6 + Math.random() * 8,
        size: high ? 2.2 + Math.random() * 2.6 : 1.3 + Math.random() * 2,
        alpha: high ? 0.34 : 0.2,
        sprite: high ? 'highlight' : 'primary',
        drag: 0.997,
        wobble: 0.4 + Math.random() * 0.7,
      });
    }
  }

  /* -------------------------------------------------- notes */

  noteOn({ id, midi, velocity = 0.75, adjusted = false }) {
    if (!id || !Number.isFinite(midi)) return;
    const now = this.clock();
    const note = {
      id,
      midi,
      start: now,
      end: Number.POSITIVE_INFINITY,
      velocity: clamp(velocity, 0.05, 1),
      adjusted,
      instrument: this.instrument.id,
      source: 'live',
      emitAccumulator: 0,
      anchor: null,
    };
    this.activeNotes.set(id, note);
    this.spawnNoteEffect(note);
  }

  noteOff(id) {
    const note = this.activeNotes.get(id);
    if (!note) return;
    note.end = Math.min(note.end, this.clock());
  }

  scheduleNote({ id, when, midi, duration = 0.5, velocity = 0.75, adjusted = false }) {
    if (!id || !Number.isFinite(when) || !Number.isFinite(midi)) return;
    this.pending.push({
      kind: 'note',
      when,
      note: {
        id,
        midi,
        start: when,
        end: when + Math.max(0.08, duration),
        duration: Math.max(0.08, duration),
        velocity: clamp(velocity, 0.05, 1),
        adjusted,
        instrument: this.instrument.id,
        source: 'score',
        emitAccumulator: 0,
        anchor: null,
      },
    });
    if (this.pending.length > 600) this.pending.splice(0, this.pending.length - 600);
  }

  scheduleBeat({ when, accent = false }) {
    if (!Number.isFinite(when)) return;
    this.pending.push({ kind: 'beat', when, accent });
  }

  clearTimeline() {
    this.pending = this.pending.filter((item) => item.kind === 'note' && item.note.source === 'live');
    for (const [id, note] of this.activeNotes) {
      if (note.source === 'score') this.activeNotes.delete(id);
    }
  }

  allNotesOff() {
    this.pending = [];
    this.activeNotes.clear();
  }

  processPending(now) {
    if (!this.pending.length) return;
    const keep = [];
    for (const item of this.pending) {
      if (item.when > now + 0.006) {
        keep.push(item);
        continue;
      }
      // 页面长时间隐藏后，不要把积压的旧事件一次性喷出来。
      if (now - item.when > 1.5) continue;
      if (item.kind === 'note') {
        const note = item.note;
        const existing = this.activeNotes.get(note.id);
        if (existing && existing.start >= note.start) continue;
        this.activeNotes.set(note.id, note);
        this.spawnNoteEffect(note);
      } else if (item.kind === 'beat') {
        this.pulseBeat(item.accent);
      }
    }
    this.pending = keep;
  }

  updateActiveNotes(now, dt) {
    for (const [id, note] of this.activeNotes) {
      if (Number.isFinite(note.end) && now > note.end + 0.6) {
        this.activeNotes.delete(id);
        continue;
      }
      if (note.start > now || now > note.end) continue;
      if (note.instrument !== this.instrument.id) continue;
      this.emitSustained(note, dt);
    }
  }

  emitSustained(note, dt) {
    const config = this.instrument;
    const high = clamp((note.midi - config.minMidi) / Math.max(1, config.maxMidi - config.minMidi), 0, 1);
    let rate = 0;
    if (config.id === 'piano') rate = 6 + high * 10;
    else if (config.id === 'violin') rate = 8 + high * 14;
    else if (config.id === 'sax') rate = 14 + high * 10;
    else if (config.id === 'flute') rate = 6 + high * 10;
    else if (config.id === 'guitar') rate = 7 + high * 7;
    if (rate <= 0 || this.reducedMotion) return;
    note.emitAccumulator = (note.emitAccumulator || 0) + dt * rate;
    while (note.emitAccumulator >= 1) {
      note.emitAccumulator -= 1;
      const anchor = note.anchor || this.noteAnchor(note.instrument, note.midi);
      if (!anchor) continue;
      const spread = 0.5 + note.velocity * 0.7;
      if (config.id === 'piano') {
        this.spawnParticle({
          x: anchor.x + (Math.random() - 0.5) * anchor.width * 0.5,
          y: anchor.y + 2,
          vx: (Math.random() - 0.5) * 12,
          vy: -(32 + Math.random() * 58 + high * 70),
          ay: -10,
          life: 0.7 + Math.random() * 1.1,
          size: 1.8 + Math.random() * 2.8 + high * 1.6,
          alpha: (0.38 + high * 0.3) * spread,
          sprite: high > 0.68 ? 'white' : 'accent',
          drag: 0.985,
          wobble: 0.2 + Math.random() * 0.35,
        });
      } else if (config.id === 'violin') {
        this.spawnParticle({
          x: anchor.x + (Math.random() - 0.5) * anchor.width * 0.7,
          y: anchor.y + (Math.random() - 0.5) * 26,
          vx: (Math.random() - 0.5) * 16,
          vy: (Math.random() - 0.5) * 48,
          life: 0.8 + Math.random() * 0.9,
          size: 1.4 + Math.random() * 2.4,
          alpha: (0.25 + high * 0.35) * spread,
          sprite: high > 0.5 ? 'highlight' : 'accent',
          drag: 0.98,
        });
      } else if (config.id === 'sax') {
        const direction = Math.random() < 0.5 ? -1 : 1;
        this.spawnParticle({
          x: anchor.x + Math.random() * 20,
          y: anchor.y + (Math.random() - 0.5) * 20,
          vx: 40 + Math.random() * 85,
          vy: direction * (8 + Math.random() * 34),
          life: 0.6 + Math.random() * 0.9,
          size: 1.5 + Math.random() * 2.6,
          alpha: 0.22 + high * 0.2,
          sprite: high > 0.55 ? 'highlight' : 'accent',
          drag: 0.985,
        });
      } else if (config.id === 'flute') {
        const side = Math.random() < 0.5 ? -1 : 1;
        this.spawnParticle({
          x: anchor.x + (Math.random() - 0.5) * 8,
          y: anchor.y + side * 5,
          vx: (Math.random() - 0.5) * 18,
          vy: side * (35 + Math.random() * 80) * (0.6 + high),
          life: 0.28 + Math.random() * 0.45,
          size: 1 + Math.random() * 2,
          alpha: 0.35 + high * 0.35,
          sprite: 'highlight',
          drag: 0.96,
        });
      } else if (config.id === 'guitar') {
        this.spawnParticle({
          x: anchor.x + Math.random() * 18,
          y: anchor.y + (Math.random() - 0.5) * 5,
          vx: 22 + Math.random() * 32,
          vy: (Math.random() - 0.5) * 6,
          life: 0.8 + Math.random() * 0.9,
          size: 1.6 + Math.random() * 2.4,
          alpha: 0.26 + high * 0.22,
          sprite: 'accent',
          drag: 0.985,
        });
      }
    }
  }

  spawnNoteEffect(note) {
    const config = this.instrument;
    note.anchor = this.noteAnchor(config.id, note.midi, note);
    const density = clamp(this.theme.density, 0.4, 1.8);
    const velocity = note.velocity;
    const high = clamp(
      (note.midi - config.minMidi) / Math.max(1, config.maxMidi - config.minMidi),
      0,
      1
    );

    if (config.id === 'piano') this.spawnPiano(note, high, density, velocity);
    else if (config.id === 'guitar') this.spawnGuitar(note, high, density, velocity);
    else if (config.id === 'violin') this.spawnViolin(note, high, density, velocity);
    else if (config.id === 'sax') this.spawnSax(note, high, density, velocity);
    else this.spawnFlute(note, high, density, velocity);
  }

  noteAnchor(instrumentId, midi, note = null) {
    const w = this.width;
    const h = this.height;
    if (instrumentId === 'piano') {
      const layout = this.pianoLayout();
      const key = this.pianoKeyForMidi(midi);
      if (!key) return { x: w / 2, y: h * 0.65, width: 20 };
      return { x: key.x, y: layout.rect.y, width: key.width };
    }
    if (instrumentId === 'guitar') {
      const layout = this.guitarLayout();
      const pos = this.guitarPosition(midi);
      return { x: pos.x, y: pos.y, width: 24, string: pos.string, fret: pos.fret, layout };
    }
    if (instrumentId === 'violin') {
      const layout = this.violinLayout();
      const y = this.violinY(midi, layout);
      return { x: layout.board.x + layout.board.w / 2, y, width: layout.board.w };
    }
    if (instrumentId === 'sax') {
      const layout = this.saxLayout();
      return { x: layout.bellX, y: layout.bellY, width: 40 };
    }
    const layout = this.fluteLayout();
    const hole = this.fluteHole(midi, layout);
    return { x: hole.x, y: hole.y, width: 20, holeIndex: hole.index };
  }

  /* -------------------------------------------------- instrument effects */

  spawnPiano(note, high, density, velocity) {
    const anchor = note.anchor;
    const count = Math.round((16 + velocity * 20) * density);
    for (let i = 0; i < count; i += 1) {
      this.spawnParticle({
        x: anchor.x + (Math.random() - 0.5) * anchor.width * 0.65,
        y: anchor.y + 2,
        vx: (Math.random() - 0.5) * (8 + high * 16),
        vy: -(24 + Math.random() * 70 + high * 100),
        ay: -13 - high * 10,
        life: 0.8 + Math.random() * 1.3,
        size: 2 + Math.random() * 3.2 + high * 2.2,
        alpha: (0.45 + high * 0.4) * (0.7 + velocity * 0.6),
        sprite: high > 0.72 ? 'white' : 'accent',
        drag: 0.985,
        wobble: 0.2 + Math.random() * 0.5,
      });
    }
    this.spawnRing({
      x: anchor.x,
      y: anchor.y,
      r0: 2,
      r1: Math.max(12, anchor.width * 0.85),
      life: 0.7,
      alpha: 0.24 + high * 0.16,
      color: 'highlight',
      width: 1,
    });
  }

  spawnGuitar(note, high, density, velocity) {
    const anchor = note.anchor;
    if (!anchor) return;
    const count = Math.round((14 + velocity * 14) * density);
    const lifeScale = 1.4 - high * 0.7;
    for (let i = 0; i < count; i += 1) {
      this.spawnParticle({
        x: anchor.x + Math.random() * 20,
        y: anchor.y + (Math.random() - 0.5) * 8,
        vx: 25 + Math.random() * (50 + high * 40),
        vy: (Math.random() - 0.5) * (5 + high * 8),
        life: (0.7 + Math.random() * 1.1) * lifeScale,
        size: 1.6 + Math.random() * 2.8,
        alpha: (0.28 + high * 0.36) * (0.65 + velocity * 0.6),
        sprite: high > 0.5 ? 'highlight' : 'accent',
        drag: 0.985,
        stretch: 1.5 + (1 - high) * 1.4,
        angle: 0,
      });
    }
    this.spawnRing({
      x: anchor.x,
      y: anchor.y,
      r0: 2,
      r1: 16 + (1 - high) * 18,
      life: 0.6,
      alpha: 0.2 + high * 0.12,
      color: 'accent',
      width: 1.2,
    });
  }

  spawnViolin(note, high, density, velocity) {
    const anchor = note.anchor;
    if (!anchor) return;
    const count = Math.round((10 + high * 16 + velocity * 8) * density);
    for (let i = 0; i < count; i += 1) {
      const direction = Math.random() < 0.5 ? -1 : 1;
      this.spawnParticle({
        x: anchor.x + (Math.random() - 0.5) * anchor.width * 0.75,
        y: anchor.y + (Math.random() - 0.5) * 22,
        vx: (Math.random() - 0.5) * 16,
        vy: direction * (18 + Math.random() * (42 + high * 55)),
        life: 0.65 + Math.random() * 1.05,
        size: 1.1 + Math.random() * 2.1 + high * 1.1,
        alpha: (0.22 + high * 0.33) * (0.7 + velocity * 0.5),
        sprite: high > 0.45 ? 'highlight' : 'accent',
        drag: 0.985,
        wobble: 0.3 + Math.random() * 0.4,
      });
    }
    this.spawnRing({
      x: anchor.x,
      y: anchor.y,
      r0: anchor.width * 0.12,
      r1: anchor.width * 0.8,
      life: 0.8,
      alpha: 0.22 + high * 0.16,
      color: 'highlight',
      width: 1,
    });
  }

  spawnSax(note, high, density, velocity) {
    const anchor = note.anchor;
    if (!anchor) return;
    const count = Math.round((16 + velocity * 16) * density);
    for (let i = 0; i < count; i += 1) {
      const spread = (Math.random() - 0.5) * (40 + (1 - high) * 40);
      this.spawnParticle({
        x: anchor.x + Math.random() * 10,
        y: anchor.y + (Math.random() - 0.5) * 12,
        vx: 45 + Math.random() * (90 + high * 50),
        vy: spread,
        life: 0.55 + Math.random() * 0.95,
        size: 1.8 + Math.random() * 3,
        alpha: (0.3 + high * 0.3) * (0.7 + velocity * 0.5),
        sprite: high > 0.5 ? 'highlight' : 'accent',
        drag: 0.985,
        stretch: 1.4,
        angle: Math.atan2(spread, 80) * 0.4,
      });
    }
    this.spawnRing({
      x: anchor.x,
      y: anchor.y,
      r0: 3,
      r1: 22 + high * 12,
      life: 0.6,
      alpha: 0.2,
      color: 'accent',
      width: 1.2,
    });
  }

  spawnFlute(note, high, density, velocity) {
    const anchor = note.anchor;
    if (!anchor) return;
    const count = Math.round((6 + high * 9 + velocity * 5) * density);
    for (let i = 0; i < count; i += 1) {
      const side = Math.random() < 0.5 ? -1 : 1;
      this.spawnParticle({
        x: anchor.x + (Math.random() - 0.5) * 8,
        y: anchor.y + side * 4,
        vx: (Math.random() - 0.5) * 22,
        vy: side * (45 + Math.random() * (75 + high * 80)),
        life: 0.24 + Math.random() * 0.46,
        size: 0.9 + Math.random() * 1.9,
        alpha: 0.34 + high * 0.36,
        sprite: 'white',
        drag: 0.96,
      });
    }
    this.spawnRing({
      x: anchor.x,
      y: anchor.y,
      r0: 2,
      r1: 8 + high * 8,
      life: 0.45,
      alpha: 0.28 + high * 0.2,
      color: 'white',
      width: 1,
    });
  }

  spawnRing({ x, y, r0 = 2, r1 = 24, life = 0.6, alpha = 0.24, color = 'primary', width = 1 }) {
    this.rings.push({
      x,
      y,
      r0,
      r1,
      life,
      age: 0,
      alpha,
      color,
      width,
    });
  }

  /* -------------------------------------------------- layout helpers */

  pianoLayout() {
    const w = this.width;
    const h = this.height;
    const rect = {
      x: Math.max(18, w * 0.075),
      y: h * 0.62,
      w: w * 0.85,
      h: Math.max(72, Math.min(164, h * 0.22)),
    };
    return { rect, low: 48, high: 84 };
  }

  pianoKeyForMidi(midi) {
    const { rect, low, high } = this.pianoLayout();
    const clamped = clamp(midi, low, high);
    const whiteKeys = [];
    for (let m = low; m <= high; m += 1) {
      if (!isBlackKey(m)) whiteKeys.push(m);
    }
    const whiteWidth = rect.w / whiteKeys.length;
    let whiteIndex = -1;
    for (let i = 0; i < whiteKeys.length; i += 1) {
      if (whiteKeys[i] <= clamped) whiteIndex = i;
    }
    const lowerWhite = whiteKeys[Math.max(0, whiteIndex)];
    const upperWhite = whiteKeys[Math.min(whiteKeys.length - 1, whiteIndex + 1)];
    const remainder = clamped - lowerWhite;
    const isBlack = isBlackKey(clamped);
    if (isBlack) {
      const x = rect.x + (Math.max(0, whiteIndex) + 1) * whiteWidth;
      return {
        x,
        width: whiteWidth * 0.62,
        black: true,
        top: rect.y,
        bottom: rect.y + rect.h * 0.63,
      };
    }
    const index = Math.max(0, whiteKeys.indexOf(clamped));
    return {
      x: rect.x + index * whiteWidth + whiteWidth / 2,
      width: whiteWidth,
      black: false,
      top: rect.y,
      bottom: rect.y + rect.h,
    };
  }

  guitarLayout() {
    const w = this.width;
    const h = this.height;
    const board = { x: w * 0.09, y: h * 0.36, w: w * 0.82, h: h * 0.28 };
    const tunings = [64, 59, 55, 50, 45, 40]; // 1 弦到 6 弦
    const strings = tunings.map((open, index) => ({
      open,
      index,
      y: board.y + (index + 0.5) * (board.h / 6),
    }));
    return { board, strings, fretCount: 12 };
  }

  guitarPosition(midi) {
    const { board, strings, fretCount } = this.guitarLayout();
    let best = null;
    for (const string of strings) {
      const fret = midi - string.open;
      if (fret >= 0 && fret <= fretCount) {
        if (!best || fret < best.fret) best = { string, fret };
      }
    }
    if (!best) {
      const string = strings.reduce((closest, item) =>
        Math.abs(item.open - midi) < Math.abs(closest.open - midi) ? item : closest
      , strings[0]);
      const fret = clamp(midi - string.open, 0, fretCount);
      best = { string, fret };
    }
    const fretX = board.x + (best.fret / fretCount) * board.w;
    return {
      x: fretX,
      y: best.string.y,
      string: best.string.index,
      fret: best.fret,
      board,
      fretX,
      stringY: best.string.y,
    };
  }

  violinLayout() {
    const w = this.width;
    const h = this.height;
    const bw = clamp(w * 0.115, 68, 118);
    return {
      board: {
        x: w * 0.5 - bw / 2,
        y: h * 0.13,
        w: bw,
        h: h * 0.68,
      },
      strings: [55, 62, 69, 76],
    };
  }

  violinY(midi, layout = this.violinLayout()) {
    const config = this.instrument;
    const t = clamp((midi - config.minMidi) / Math.max(1, config.maxMidi - config.minMidi), 0, 1);
    return layout.board.y + (1 - t) * layout.board.h;
  }

  saxLayout() {
    const w = this.width;
    const h = this.height;
    return {
      mouthX: w * 0.16,
      mouthY: h * 0.38,
      bellX: w * 0.64,
      bellY: h * 0.53,
      bodyY: h * 0.5,
    };
  }

  fluteLayout() {
    const w = this.width;
    const h = this.height;
    const rect = {
      x: w * 0.12,
      y: h * 0.55,
      w: w * 0.76,
      h: Math.max(14, Math.min(24, h * 0.035)),
    };
    const holeCount = 7;
    const holes = Array.from({ length: holeCount }, (_, index) => ({
      x: rect.x + rect.w * (0.22 + (index / (holeCount - 1)) * 0.68),
      y: rect.y + rect.h / 2,
      index,
    }));
    return { rect, holes };
  }

  fluteHole(midi, layout = this.fluteLayout()) {
    const config = this.instrument;
    const t = clamp((midi - config.minMidi) / Math.max(1, config.maxMidi - config.minMidi), 0, 0.999);
    const index = Math.floor(t * layout.holes.length);
    return layout.holes[clamp(index, 0, layout.holes.length - 1)];
  }

  /* -------------------------------------------------- drawing: background */

  drawAura(now = 0) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    const brightness = this.theme.brightness;
    const glow = ctx.createRadialGradient(w * 0.5, h * 0.46, 0, w * 0.5, h * 0.46, Math.max(w, h) * 0.62);
    glow.addColorStop(0, rgba(this.palette.highlight, 0.22 * brightness));
    glow.addColorStop(0.45, rgba(this.palette.primary, 0.09 * brightness));
    glow.addColorStop(1, rgba(this.palette.primary, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const warm = ctx.createRadialGradient(w * 0.28, h * 0.78, 0, w * 0.28, h * 0.78, Math.max(w, h) * 0.5);
    warm.addColorStop(0, rgba(this.palette.warm, 0.1 * brightness));
    warm.addColorStop(0.6, rgba(this.palette.warm, 0.03 * brightness));
    warm.addColorStop(1, rgba(this.palette.warm, 0));
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, w, h);

    // 缓慢呼吸的椭圆光轨，给静止舞台一点空间结构。
    ctx.save();
    ctx.translate(w * 0.5, h * 0.46);
    ctx.rotate(Math.sin(now * 0.06) * 0.06);
    for (let i = 0; i < 3; i += 1) {
      const scale = 1 + Math.sin(now * 0.35 + i) * 0.02;
      ctx.beginPath();
      ctx.ellipse(
        0,
        0,
        w * (0.29 - i * 0.055) * scale,
        h * (0.13 - i * 0.025) * scale,
        0,
        0,
        TAU
      );
      ctx.strokeStyle = rgba(this.palette.accent, 0.045 - i * 0.01);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  softAura(x, y, radius, alpha, colorKey = 'accent') {
    if (radius <= 0) return;
    const ctx = this.ctx;
    const color = this.palette[colorKey] || this.palette.accent;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, rgba(color, alpha));
    gradient.addColorStop(0.5, rgba(color, alpha * 0.35));
    gradient.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }

  drawSmoke(now) {
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    for (const puff of this.smoke) {
      const x = w * (puff.nx + Math.sin(now * puff.speed + puff.phase) * 0.045);
      const y = h * (puff.ny + Math.cos(now * puff.speed * 0.8 + puff.phase) * 0.035);
      const size = Math.min(w, h) * puff.radius * 1.9;
      const sprite = this.smokeSprites[puff.sprite];
      if (!sprite) continue;
      ctx.globalAlpha = puff.alpha * this.theme.brightness;
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  /* -------------------------------------------------- drawing: instruments */

  drawInstrument(now) {
    const id = this.instrument.id;
    if (id === 'piano') this.drawPiano(now);
    else if (id === 'guitar') this.drawGuitar(now);
    else if (id === 'violin') this.drawViolin(now);
    else if (id === 'sax') this.drawSax(now);
    else this.drawFlute(now);
  }

  activeNotesFor(now, instrumentId = this.instrument.id) {
    const list = [];
    for (const note of this.activeNotes.values()) {
      if (note.instrument !== instrumentId) continue;
      if (note.start > now + 0.05) continue;
      if (now > note.end) continue;
      list.push(note);
    }
    return list;
  }

  drawPiano(now) {
    const ctx = this.ctx;
    const { rect, low, high } = this.pianoLayout();
    const whiteKeys = [];
    for (let midi = low; midi <= high; midi += 1) {
      if (!isBlackKey(midi)) whiteKeys.push(midi);
    }
    const whiteWidth = rect.w / whiteKeys.length;
    const blackHeight = rect.h * 0.63;
    const active = this.activeNotesFor(now, 'piano');

    // 琴体底影
    const shadow = ctx.createLinearGradient(0, rect.y + rect.h, 0, rect.y + rect.h + 34);
    shadow.addColorStop(0, rgba(this.palette.primary, 0.12));
    shadow.addColorStop(1, rgba(this.palette.primary, 0));
    ctx.fillStyle = shadow;
    ctx.fillRect(rect.x - 20, rect.y + rect.h, rect.w + 40, 34);

    // 琴床暖光
    const bedGlow = ctx.createRadialGradient(
      rect.x + rect.w * 0.5,
      rect.y + rect.h * 0.4,
      0,
      rect.x + rect.w * 0.5,
      rect.y + rect.h * 0.4,
      rect.w * 0.55
    );
    bedGlow.addColorStop(0, rgba(this.palette.highlight, 0.1));
    bedGlow.addColorStop(0.6, rgba(this.palette.primary, 0.03));
    bedGlow.addColorStop(1, rgba(this.palette.primary, 0));
    ctx.fillStyle = bedGlow;
    ctx.fillRect(rect.x - 30, rect.y - rect.h * 0.35, rect.w + 60, rect.h * 1.6);

    for (let i = 0; i < whiteKeys.length; i += 1) {
      const x = rect.x + i * whiteWidth;
      roundRectPath(ctx, x + 1, rect.y, whiteWidth - 2, rect.h, 4);
      const keyGradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
      keyGradient.addColorStop(0, rgba('#9db9e8', 0.2));
      keyGradient.addColorStop(0.24, rgba('#ffffff', 0.26));
      keyGradient.addColorStop(0.78, rgba(this.palette.highlight, 0.14));
      keyGradient.addColorStop(1, rgba(this.palette.primary, 0.08));
      ctx.fillStyle = keyGradient;
      ctx.fill();
      ctx.strokeStyle = rgba('#5f7fa9', 0.34);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (let i = 0; i < whiteKeys.length - 1; i += 1) {
      const midi = whiteKeys[i];
      if (!isBlackKey(midi + 1)) continue;
      const x = rect.x + (i + 1) * whiteWidth - (whiteWidth * 0.62) / 2;
      roundRectPath(ctx, x, rect.y, whiteWidth * 0.62, blackHeight, 3);
      const keyGradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + blackHeight);
      keyGradient.addColorStop(0, rgba('#34405f', 0.52));
      keyGradient.addColorStop(0.7, rgba('#465675', 0.4));
      keyGradient.addColorStop(1, rgba('#5b6d8f', 0.3));
      ctx.fillStyle = keyGradient;
      ctx.fill();
      ctx.strokeStyle = rgba('#2f3b57', 0.32);
      ctx.stroke();
    }

    // 键盘顶部的柔光边
    const topEdge = ctx.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
    topEdge.addColorStop(0, rgba(this.palette.primary, 0));
    topEdge.addColorStop(0.25, rgba(this.palette.highlight, 0.3));
    topEdge.addColorStop(0.5, rgba(this.palette.accent, 0.16));
    topEdge.addColorStop(0.75, rgba(this.palette.highlight, 0.26));
    topEdge.addColorStop(1, rgba(this.palette.warm, 0));
    ctx.fillStyle = topEdge;
    ctx.fillRect(rect.x, rect.y - 2, rect.w, 2);

    // 静止时的呼吸光柱，让舞台不显得空。
    for (let i = 0; i < 3; i += 1) {
      const x = rect.x + rect.w * (0.2 + i * 0.3 + Math.sin(now * 0.16 + i * 1.9) * 0.045);
      const alpha = 0.024 + (Math.sin(now * 0.42 + i * 2.2) + 1) * 0.012;
      const idleWidth = 26 + i * 10;
      const idleTop = rect.y - this.height * (0.34 + i * 0.06);
      const idleGradient = ctx.createLinearGradient(0, rect.y, 0, idleTop);
      idleGradient.addColorStop(0, rgba(this.palette.highlight, alpha));
      idleGradient.addColorStop(0.6, rgba(this.palette.accent, alpha * 0.5));
      idleGradient.addColorStop(1, rgba(this.palette.accent, 0));
      ctx.fillStyle = idleGradient;
      ctx.fillRect(x - idleWidth / 2, idleTop, idleWidth, rect.y - idleTop);
    }

    // C 音提示
    ctx.font = '500 10px "Segoe UI", "PingFang SC", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba('#53607d', 0.4);
    for (let i = 0; i < whiteKeys.length; i += 1) {
      if (whiteKeys[i] % 12 === 0) {
        ctx.fillText(midiToName(whiteKeys[i]), rect.x + (i + 0.5) * whiteWidth, rect.y + rect.h - 8);
      }
    }

    // 活动键与光柱
    for (const note of active) {
      const key = this.pianoKeyForMidi(note.midi);
      if (!key) continue;
      const highT = clamp((note.midi - low) / (high - low), 0, 1);
      const fade = Number.isFinite(note.end)
        ? clamp((note.end - now) / 0.35, 0, 1)
        : 1;
      const pulse = 0.86 + Math.sin(now * 7 + note.midi) * 0.14;
      const width = lerp(26, 5, highT);
      const beamTop = rect.y - this.height * (0.38 + highT * 0.2);
      const gradient = ctx.createLinearGradient(0, rect.y, 0, beamTop);
      gradient.addColorStop(0, rgba(this.palette.accent, (0.82 + highT * 0.16) * fade * pulse));
      gradient.addColorStop(0.22, rgba(this.palette.accent, (0.48 + highT * 0.22) * fade));
      gradient.addColorStop(0.66, rgba(this.palette.primary, (0.18 + highT * 0.14) * fade));
      gradient.addColorStop(1, rgba(this.palette.primary, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(key.x - width / 2, beamTop, width, rect.y - beamTop);

      // 外层柔光柱
      const outer = ctx.createLinearGradient(0, rect.y, 0, beamTop);
      outer.addColorStop(0, rgba(this.palette.primary, 0.22 * fade));
      outer.addColorStop(0.5, rgba(this.palette.primary, 0.07 * fade));
      outer.addColorStop(1, rgba(this.palette.primary, 0));
      ctx.fillStyle = outer;
      ctx.fillRect(key.x - width * 2.4, beamTop, width * 4.8, rect.y - beamTop);

      // 细白核心
      const core = ctx.createLinearGradient(0, rect.y, 0, rect.y - this.height * 0.42);
      core.addColorStop(0, rgba('#ffffff', 0.9 * fade));
      core.addColorStop(0.55, rgba(this.palette.highlight, 0.35 * fade));
      core.addColorStop(1, rgba('#ffffff', 0));
      ctx.fillStyle = core;
      ctx.fillRect(key.x - 1.4, rect.y - this.height * 0.42, 2.8, this.height * 0.42);

      const sprite = this.sprites.highlight;
      const bloom = 44 + highT * 32;
      ctx.globalAlpha = (0.8 + highT * 0.2) * fade;
      ctx.drawImage(sprite, key.x - bloom, rect.y - bloom, bloom * 2, bloom * 2);
      ctx.globalAlpha = 1;

      // 键面高亮
      roundRectPath(ctx, key.x - key.width / 2 + 2, rect.y + 2, key.width - 4, rect.h * 0.96, 4);
      ctx.fillStyle = rgba(this.palette.highlight, 0.2 + highT * 0.14);
      ctx.fill();
    }
  }

  drawGuitar(now) {
    const ctx = this.ctx;
    const { board, strings, fretCount } = this.guitarLayout();
    const active = this.activeNotesFor(now, 'guitar');

    this.softAura(board.x + board.w * 0.5, board.y + board.h * 0.5, board.w * 0.46, 0.1, 'warm');
    this.softAura(board.x + board.w * 0.3, board.y + board.h * 0.4, board.w * 0.25, 0.08, 'accent');

    roundRectPath(ctx, board.x, board.y, board.w, board.h, 18);
    const bodyGradient = ctx.createLinearGradient(0, board.y, 0, board.y + board.h);
    bodyGradient.addColorStop(0, rgba(this.palette.warm, 0.18));
    bodyGradient.addColorStop(0.5, rgba(this.palette.accent, 0.1));
    bodyGradient.addColorStop(1, rgba(this.palette.primary, 0.15));
    ctx.fillStyle = bodyGradient;
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.34);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 音孔
    ctx.beginPath();
    ctx.ellipse(board.x + board.w * 0.16, board.y + board.h * 0.5, board.w * 0.045, board.h * 0.16, 0, 0, TAU);
    ctx.fillStyle = rgba('#3c4966', 0.09);
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.22);
    ctx.stroke();

    // 品丝
    for (let fret = 0; fret <= fretCount; fret += 1) {
      const x = board.x + (fret / fretCount) * board.w;
      ctx.beginPath();
      ctx.moveTo(x, board.y + 5);
      ctx.lineTo(x, board.y + board.h - 5);
      ctx.strokeStyle = rgba(this.palette.accent, fret === 0 ? 0.24 : 0.13);
      ctx.lineWidth = fret === 0 ? 2 : 1;
      ctx.stroke();
    }
    // 品位标记
    ctx.fillStyle = rgba(this.palette.highlight, 0.18);
    for (const fret of [3, 5, 7, 9, 12]) {
      const x = board.x + (fret / fretCount) * board.w;
      ctx.beginPath();
      ctx.arc(x, board.y + board.h * 0.5, 3, 0, TAU);
      ctx.fill();
    }

    // 琴弦
    ctx.font = '500 9px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    for (const string of strings) {
      const activeString = active.find((note) => {
        const pos = this.guitarPosition(note.midi);
        return pos.string === string.index;
      });
      const thickness = 0.7 + (1 - string.index / 5) * 0.9;
      if (activeString) {
        const pos = this.guitarPosition(activeString.midi);
        const highT = clamp((activeString.midi - 40) / 48, 0, 1);
        const length = board.w * lerp(0.72, 0.38, highT);
        const alpha = (0.4 + highT * 0.3) * (0.7 + activeString.velocity * 0.4);
        const wobbleAmp =
          (0.4 + (1 - highT) * 3.6) *
          Math.max(0.18, 1 - (now - activeString.start) * 0.9);

        const path = (ampScale) => {
          ctx.beginPath();
          for (let x = pos.fretX; x <= pos.fretX + length; x += 5) {
            const t = (x - pos.fretX) / 22;
            const y =
              pos.stringY +
              Math.sin(t - now * 17) *
                wobbleAmp *
                ampScale *
                (1 - (x - pos.fretX) / length);
            if (x === pos.fretX) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
        };

        // 外层柔光
        ctx.strokeStyle = rgba(this.palette.accent, alpha * 0.24);
        ctx.lineWidth = 20 + (1 - highT) * 12;
        path(1.25);
        ctx.stroke();

        // 主体拖尾
        const streak = ctx.createLinearGradient(pos.fretX, 0, pos.fretX + length, 0);
        streak.addColorStop(0, rgba(this.palette.accent, alpha));
        streak.addColorStop(0.45, rgba(this.palette.primary, alpha * 0.55));
        streak.addColorStop(1, rgba(this.palette.primary, 0));
        ctx.strokeStyle = streak;
        ctx.lineWidth = 7 + (1 - highT) * 6;
        path(1);
        ctx.stroke();

        // 白热核心
        ctx.strokeStyle = rgba(this.palette.highlight, Math.min(0.92, alpha * 1.5));
        ctx.lineWidth = 1.8;
        path(1);
        ctx.stroke();

        const glow = this.sprites.highlight;
        const bloom = 30 + (1 - highT) * 24;
        ctx.globalAlpha = Math.min(0.95, alpha * 1.3);
        ctx.drawImage(glow, pos.fretX - bloom, pos.stringY - bloom, bloom * 2, bloom * 2);
        ctx.globalAlpha = alpha * 0.55;
        ctx.drawImage(
          glow,
          pos.fretX + length * 0.4 - 18,
          pos.stringY - 18,
          36,
          36
        );
        ctx.globalAlpha = 1;

        ctx.beginPath();
        ctx.ellipse(pos.fretX, pos.stringY, 7, 7, 0, 0, TAU);
        ctx.strokeStyle = rgba(this.palette.highlight, 0.6);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        const shimmer = 0.24 + (Math.sin(now * 0.7 + string.index * 1.1) + 1) * 0.035;
        ctx.strokeStyle = rgba('#526582', shimmer);
        ctx.lineWidth = thickness;
        ctx.beginPath();
        ctx.moveTo(board.x, string.y);
        ctx.lineTo(board.x + board.w, string.y);
        ctx.stroke();
      }
      ctx.fillStyle = rgba('#5b6680', 0.42);
      ctx.fillText(String(string.index + 1), board.x - 8, string.y + 3);
    }

    // 品位数
    ctx.textAlign = 'center';
    ctx.fillStyle = rgba('#5b6680', 0.38);
    ctx.font = '500 9px "Segoe UI", sans-serif';
    for (let fret = 1; fret <= Math.min(6, fretCount); fret += 1) {
      const x = board.x + (fret / fretCount) * board.w;
      ctx.fillText(String(fret), x, board.y + 12);
    }
  }

  drawViolin(now) {
    const ctx = this.ctx;
    const { board, strings } = this.violinLayout();
    const active = this.activeNotesFor(now, 'violin');

    this.softAura(board.x + board.w / 2, board.y + board.h * 0.58, board.w * 1.3, 0.11, 'accent');

    // 琴身：上下两个琴肩，给指板一个可识别的轮廓。
    const cx = board.x + board.w / 2;
    const bodyTop = board.y + board.h * 0.3;
    const bodyH = board.h * 0.66;
    ctx.beginPath();
    ctx.ellipse(cx, bodyTop + bodyH * 0.26, board.w * 0.92, bodyH * 0.28, 0, 0, TAU);
    ctx.fillStyle = rgba(this.palette.warm, 0.1);
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.24);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, bodyTop + bodyH * 0.7, board.w * 1.04, bodyH * 0.34, 0, 0, TAU);
    ctx.fillStyle = rgba(this.palette.warm, 0.12);
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.26);
    ctx.stroke();

    // f 孔
    ctx.strokeStyle = rgba('#4e5c77', 0.22);
    ctx.lineWidth = 1.1;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + side * board.w * 0.38, bodyTop + bodyH * 0.46);
      ctx.bezierCurveTo(
        cx + side * board.w * 0.5,
        bodyTop + bodyH * 0.55,
        cx + side * board.w * 0.3,
        bodyTop + bodyH * 0.66,
        cx + side * board.w * 0.4,
        bodyTop + bodyH * 0.76
      );
      ctx.stroke();
    }

    // 指板
    roundRectPath(ctx, board.x, board.y, board.w, board.h, board.w * 0.42);
    const boardGradient = ctx.createLinearGradient(board.x, 0, board.x + board.w, 0);
    boardGradient.addColorStop(0, rgba(this.palette.accent, 0.14));
    boardGradient.addColorStop(0.5, rgba('#ffffff', 0.27));
    boardGradient.addColorStop(1, rgba(this.palette.accent, 0.14));
    ctx.fillStyle = boardGradient;
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.38);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 琴弦
    for (let i = 0; i < 4; i += 1) {
      const x = board.x + board.w * (0.26 + i * 0.16);
      ctx.beginPath();
      ctx.moveTo(x, board.y + 8);
      ctx.lineTo(x, board.y + board.h - 8);
      ctx.strokeStyle = rgba('#526582', 0.3);
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    // 弓
    ctx.beginPath();
    ctx.moveTo(board.x - board.w * 1.1, board.y + board.h * 0.78);
    ctx.quadraticCurveTo(
      board.x + board.w * 0.5,
      board.y + board.h * (0.4 + Math.sin(now * 0.6) * 0.02),
      board.x + board.w * 1.9,
      board.y + board.h * 0.24
    );
    ctx.strokeStyle = rgba(this.palette.highlight, 0.26);
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.strokeStyle = rgba(this.palette.accent, 0.12);
    ctx.lineWidth = 7;
    ctx.stroke();

    for (const note of active) {
      const y = this.violinY(note.midi);
      const highT = clamp((note.midi - this.instrument.minMidi) / 41, 0, 1);
      const fade = Number.isFinite(note.end) ? clamp((note.end - now) / 0.4, 0, 1) : 1;
      const length = lerp(140, 230, highT);
      const outer = ctx.createLinearGradient(0, y - length / 2, 0, y + length / 2);
      outer.addColorStop(0, rgba(this.palette.accent, 0));
      outer.addColorStop(0.28, rgba(this.palette.accent, (0.16 + highT * 0.2) * fade));
      outer.addColorStop(0.5, rgba(this.palette.accent, (0.3 + highT * 0.24) * fade));
      outer.addColorStop(0.72, rgba(this.palette.primary, (0.14 + highT * 0.18) * fade));
      outer.addColorStop(1, rgba(this.palette.primary, 0));
      ctx.fillStyle = outer;
      ctx.fillRect(board.x - board.w * 0.5, y - length / 2, board.w * 2, length);

      const gradient = ctx.createLinearGradient(0, y - length * 0.36, 0, y + length * 0.36);
      gradient.addColorStop(0, rgba(this.palette.highlight, 0));
      gradient.addColorStop(0.32, rgba(this.palette.highlight, (0.3 + highT * 0.3) * fade));
      gradient.addColorStop(0.5, rgba('#ffffff', (0.55 + highT * 0.25) * fade));
      gradient.addColorStop(0.68, rgba(this.palette.accent, (0.28 + highT * 0.26) * fade));
      gradient.addColorStop(1, rgba(this.palette.accent, 0));
      ctx.fillStyle = gradient;
      ctx.fillRect(board.x - board.w * 0.2, y - length * 0.36, board.w * 1.4, length * 0.72);

      const sprite = this.sprites.highlight;
      const bloom = 28 + highT * 20;
      ctx.globalAlpha = (0.65 + highT * 0.3) * fade;
      ctx.drawImage(sprite, board.x + board.w / 2 - bloom, y - bloom, bloom * 2, bloom * 2);
      ctx.globalAlpha = 1;

      const stringX = board.x + board.w * (0.26 + Math.floor(highT * 3) * 0.16);
      ctx.strokeStyle = rgba(this.palette.highlight, 0.5 * fade);
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(stringX, y - 16);
      ctx.lineTo(stringX, y + 16);
      ctx.stroke();
    }
  }

  drawSax(now) {
    const ctx = this.ctx;
    const { mouthX, mouthY, bellX, bellY } = this.saxLayout();
    const active = this.activeNotesFor(now, 'sax');

    this.softAura(this.width * 0.42, this.height * 0.48, this.width * 0.26, 0.12, 'warm');
    this.softAura(bellX, bellY, this.height * 0.24, 0.13, 'accent');

    // 管身
    const bodyPath = () => {
      ctx.beginPath();
      ctx.moveTo(mouthX, mouthY);
      ctx.bezierCurveTo(
        this.width * 0.28,
        this.height * 0.35,
        this.width * 0.28,
        this.height * 0.62,
        this.width * 0.43,
        this.height * 0.59
      );
      ctx.bezierCurveTo(
        this.width * 0.53,
        this.height * 0.57,
        this.width * 0.57,
        this.height * 0.5,
        bellX - 6,
        bellY - 6
      );
    };

    ctx.lineCap = 'round';
    bodyPath();
    ctx.lineWidth = Math.max(26, this.height * 0.044);
    ctx.strokeStyle = rgba(this.palette.accent, 0.08);
    ctx.stroke();

    bodyPath();
    ctx.lineWidth = Math.max(16, this.height * 0.029);
    const bodyGradient = ctx.createLinearGradient(mouthX, 0, bellX, 0);
    bodyGradient.addColorStop(0, rgba(this.palette.accent, 0.42));
    bodyGradient.addColorStop(0.5, rgba(this.palette.highlight, 0.34));
    bodyGradient.addColorStop(1, rgba(this.palette.warm, 0.48));
    ctx.strokeStyle = bodyGradient;
    ctx.stroke();

    bodyPath();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = rgba('#ffffff', 0.38);
    ctx.stroke();

    // 喇叭口
    const bellGradient = ctx.createRadialGradient(bellX, bellY, 2, bellX, bellY, this.height * 0.14);
    bellGradient.addColorStop(0, rgba(this.palette.highlight, 0.5));
    bellGradient.addColorStop(0.5, rgba(this.palette.accent, 0.28));
    bellGradient.addColorStop(1, rgba(this.palette.accent, 0));
    ctx.fillStyle = bellGradient;
    ctx.beginPath();
    ctx.ellipse(bellX, bellY, this.height * 0.1, this.height * 0.13, -0.42, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.44);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 0.55;
    ctx.drawImage(this.sprites.highlight, bellX - 36, bellY - 36, 72, 72);
    ctx.globalAlpha = 1;

    // 吹嘴
    ctx.beginPath();
    ctx.moveTo(mouthX, mouthY);
    ctx.lineTo(mouthX - this.width * 0.055, mouthY - this.height * 0.02);
    ctx.strokeStyle = rgba(this.palette.highlight, 0.5);
    ctx.lineWidth = 5;
    ctx.stroke();

    // 按键
    const keyPoints = [
      [0.28, 0.43],
      [0.3, 0.49],
      [0.34, 0.54],
      [0.4, 0.57],
      [0.47, 0.56],
      [0.52, 0.53],
      [0.56, 0.49],
    ];
    keyPoints.forEach(([nx, ny], index) => {
      const x = this.width * nx;
      const y = this.height * ny;
      const lit = active.some((note) => Math.min(
        keyPoints.length - 1,
        Math.floor(((note.midi - this.instrument.minMidi) / Math.max(1, this.instrument.maxMidi - this.instrument.minMidi)) * keyPoints.length)
      ) === index);
      ctx.beginPath();
      ctx.arc(x, y, lit ? 5.5 : 3.2, 0, TAU);
      ctx.fillStyle = lit ? rgba(this.palette.highlight, 0.8) : rgba(this.palette.highlight, 0.25);
      ctx.fill();
      if (lit) {
        ctx.globalAlpha = 0.8;
        ctx.drawImage(this.sprites.highlight, x - 18, y - 18, 36, 36);
        ctx.globalAlpha = 1;
      }
    });

    // 锥形气流
    const cones = active.length
      ? active.map((note) => {
          const highT = clamp((note.midi - this.instrument.minMidi) / Math.max(1, this.instrument.maxMidi - this.instrument.minMidi), 0, 1);
          const fade = Number.isFinite(note.end) ? clamp((note.end - now) / 0.4, 0, 1) : 1;
          return {
            length: this.width * (0.34 + Math.min(4, note.duration || 1.2) * 0.022),
            spread: this.height * (0.19 - highT * 0.06),
            alpha: fade,
            highT,
          };
        })
      : [
          {
            length: this.width * (0.24 + Math.sin(now * 0.5) * 0.015),
            spread: this.height * 0.12,
            alpha: 0.22,
            highT: 0.3,
          },
        ];

    for (const cone of cones) {
      const { length, spread, alpha } = cone;

      // 外层雾锥
      ctx.beginPath();
      ctx.moveTo(bellX, bellY - 12);
      ctx.quadraticCurveTo(bellX + length * 0.55, bellY - spread * 1.25, bellX + length, bellY - spread);
      ctx.quadraticCurveTo(bellX + length * 0.55, bellY + spread * 1.25, bellX, bellY + 12);
      ctx.closePath();
      ctx.fillStyle = rgba(this.palette.accent, 0.12 * alpha);
      ctx.fill();

      // 内层气流
      const gradient = ctx.createLinearGradient(bellX, 0, bellX + length, 0);
      gradient.addColorStop(0, rgba(this.palette.highlight, 0.52 * alpha));
      gradient.addColorStop(0.32, rgba(this.palette.accent, 0.28 * alpha));
      gradient.addColorStop(0.78, rgba(this.palette.primary, 0.1 * alpha));
      gradient.addColorStop(1, rgba(this.palette.primary, 0));
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.moveTo(bellX, bellY - 8);
      ctx.quadraticCurveTo(bellX + length * 0.55, bellY - spread, bellX + length, bellY - spread * 0.82);
      ctx.quadraticCurveTo(bellX + length * 0.55, bellY + spread * 0.82, bellX, bellY + 8);
      ctx.closePath();
      ctx.fill();

      // 气流边缘
      ctx.beginPath();
      ctx.moveTo(bellX + 8, bellY - spread * 0.18);
      ctx.quadraticCurveTo(bellX + length * 0.5, bellY - spread, bellX + length, bellY - spread * 0.8);
      ctx.moveTo(bellX + 8, bellY + spread * 0.18);
      ctx.quadraticCurveTo(bellX + length * 0.5, bellY + spread, bellX + length, bellY + spread * 0.8);
      ctx.strokeStyle = rgba(this.palette.accent, 0.22 * alpha);
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
  }

  drawFlute(now) {
    const ctx = this.ctx;
    const { rect, holes } = this.fluteLayout();
    const active = this.activeNotesFor(now, 'flute');

    this.softAura(rect.x + rect.w * 0.55, rect.y + rect.h * 0.5, rect.w * 0.34, 0.1, 'accent');

    // 管身
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, rect.h / 2);
    const tubeGradient = ctx.createLinearGradient(0, rect.y, 0, rect.y + rect.h);
    tubeGradient.addColorStop(0, rgba(this.palette.highlight, 0.34));
    tubeGradient.addColorStop(0.34, rgba(this.palette.accent, 0.2));
    tubeGradient.addColorStop(0.75, rgba(this.palette.primary, 0.16));
    tubeGradient.addColorStop(1, rgba(this.palette.primary, 0.24));
    ctx.fillStyle = tubeGradient;
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.accent, 0.44);
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 管身顶部高光
    const topLine = ctx.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
    topLine.addColorStop(0, rgba(this.palette.highlight, 0.1));
    topLine.addColorStop(0.4, rgba(this.palette.highlight, 0.55));
    topLine.addColorStop(1, rgba(this.palette.highlight, 0.12));
    ctx.fillStyle = topLine;
    ctx.fillRect(rect.x + 10, rect.y + 1.5, rect.w - 20, 1.5);

    // 吹口
    ctx.beginPath();
    ctx.ellipse(rect.x + rect.w * 0.09, rect.y + rect.h / 2, 5.5, rect.h * 0.58, 0, 0, TAU);
    ctx.fillStyle = rgba('#45516e', 0.2);
    ctx.fill();
    ctx.strokeStyle = rgba(this.palette.highlight, 0.3);
    ctx.stroke();

    // 指孔
    for (const hole of holes) {
      const lit = active.some((note) => this.fluteHole(note.midi, { rect, holes }).index === hole.index);
      ctx.beginPath();
      ctx.ellipse(hole.x, hole.y, lit ? 5.2 : 4.4, lit ? 4 : 3.4, 0, 0, TAU);
      ctx.fillStyle = lit ? rgba(this.palette.highlight, 0.8) : rgba('#45516e', 0.22);
      ctx.fill();
      ctx.strokeStyle = rgba(this.palette.highlight, lit ? 0.72 : 0.24);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (active.length) {
      const note = active[active.length - 1];
      const highT = clamp((note.midi - this.instrument.minMidi) / Math.max(1, this.instrument.maxMidi - this.instrument.minMidi), 0, 1);
      const fade = Number.isFinite(note.end) ? clamp((note.end - now) / 0.3, 0, 1) : 1;
      const tubeGlow = ctx.createLinearGradient(rect.x, 0, rect.x + rect.w, 0);
      tubeGlow.addColorStop(0, rgba(this.palette.accent, 0));
      tubeGlow.addColorStop(0.3, rgba(this.palette.accent, 0.16 * fade));
      tubeGlow.addColorStop(0.7, rgba(this.palette.highlight, (0.22 + highT * 0.2) * fade));
      tubeGlow.addColorStop(1, rgba(this.palette.accent, 0));
      ctx.fillStyle = tubeGlow;
      ctx.fillRect(rect.x + 6, rect.y - 8, rect.w - 12, rect.h + 16);

      const mouthX = rect.x + rect.w * 0.09;
      const mouthY = rect.y + rect.h / 2;
      const puff = ctx.createRadialGradient(mouthX, mouthY, 0, mouthX, mouthY, 34);
      puff.addColorStop(0, rgba(this.palette.highlight, 0.26 * fade));
      puff.addColorStop(1, rgba(this.palette.highlight, 0));
      ctx.fillStyle = puff;
      ctx.fillRect(mouthX - 34, mouthY - 34, 68, 68);
    }

    for (const note of active) {
      const hole = this.fluteHole(note.midi);
      const highT = clamp((note.midi - this.instrument.minMidi) / Math.max(1, this.instrument.maxMidi - this.instrument.minMidi), 0, 1);
      const fade = Number.isFinite(note.end) ? clamp((note.end - now) / 0.3, 0, 1) : 1;
      const sprite = this.sprites.white;
      ctx.globalAlpha = (0.55 + highT * 0.4) * fade;
      ctx.drawImage(sprite, hole.x - 16, hole.y - 16, 32, 32);
      ctx.globalAlpha = (0.4 + highT * 0.35) * fade;
      ctx.drawImage(sprite, hole.x - 7, hole.y - 28, 14, 14);
      ctx.drawImage(sprite, hole.x - 7, hole.y + 14, 14, 14);
      ctx.globalAlpha = 1;
    }
  }

  /* -------------------------------------------------- drawing: fx */

  updateRings(dt) {
    for (let i = this.rings.length - 1; i >= 0; i -= 1) {
      const ring = this.rings[i];
      ring.age += dt;
      if (ring.age >= ring.life) this.rings.splice(i, 1);
    }
  }

  drawRings() {
    const ctx = this.ctx;
    for (const ring of this.rings) {
      const t = ring.age / ring.life;
      const radius = lerp(ring.r0, ring.r1, 1 - Math.pow(1 - t, 2));
      ctx.beginPath();
      ctx.ellipse(ring.x, ring.y, radius, radius * 0.62, 0, 0, TAU);
      ctx.strokeStyle = rgba(
        this.palette[ring.color] || this.palette.highlight,
        ring.alpha * (1 - t) * this.theme.brightness
      );
      ctx.lineWidth = ring.width;
      ctx.stroke();
    }
  }

  /* -------------------------------------------------- drawing: timeline & beats */

  drawTimeline(now) {
    const ctx = this.ctx;
    const w = this.width;
    const x0 = w * 0.075;
    const x1 = w * 0.925;
    const y = 24;
    const total = this.transport.totalBeats;
    const ab = this.transport.ab || { a: null, b: null };

    // 时间轴
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.strokeStyle = rgba(this.palette.accent, 0.18);
    ctx.lineWidth = 1;
    ctx.stroke();

    if (total > 0) {
      const progress = clamp(this.transport.beat / total, 0, 1);
      const px = lerp(x0, x1, progress);
      const gradient = ctx.createLinearGradient(x0, 0, px, 0);
      gradient.addColorStop(0, rgba(this.palette.accent, 0.3));
      gradient.addColorStop(1, rgba(this.palette.highlight, 0.72));
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(px, y);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = 2;
      ctx.stroke();

      // A-B 区间
      if (Number.isFinite(ab.a) && Number.isFinite(ab.b) && ab.b > ab.a) {
        const ax = lerp(x0, x1, clamp(ab.a / total, 0, 1));
        const bx = lerp(x0, x1, clamp(ab.b / total, 0, 1));
        const activeLoop = this.transport.loopMode === 'ab';
        roundRectPath(ctx, ax, y - 4, Math.max(2, bx - ax), 8, 4);
        ctx.fillStyle = rgba(activeLoop ? this.palette.highlight : this.palette.accent, activeLoop ? 0.24 : 0.12);
        ctx.fill();
        ctx.font = '600 10px "Segoe UI", sans-serif';
        ctx.fillStyle = rgba('#4f5c78', activeLoop ? 0.7 : 0.45);
        ctx.textAlign = 'center';
        ctx.fillText('A', ax, y - 10);
        ctx.fillText('B', bx, y - 10);
      }

      // 播放头
      ctx.globalAlpha = 0.9;
      ctx.drawImage(this.sprites.highlight, px - 9, y - 9, 18, 18);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(px, y, 2.4, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }

    // 小节节拍点
    const barLength = Math.max(1, this.transport.barLength || this.timeSigNum);
    if (this.transport.playing || this.transport.metronome) {
      const beatInBar = ((this.transport.beat % barLength) + barLength) % barLength;
      const activeIndex = Math.min(barLength - 1, Math.floor(beatInBar));
      const spacing = 18;
      const totalWidth = (barLength - 1) * spacing;
      const startX = w / 2 - totalWidth / 2;
      const dotY = y + 26;
      for (let i = 0; i < barLength; i += 1) {
        const x = startX + i * spacing;
        const active = i === activeIndex;
        ctx.beginPath();
        ctx.arc(x, dotY, active ? 3.2 : 1.7, 0, TAU);
        ctx.fillStyle = active
          ? rgba(this.palette.highlight, 0.85)
          : rgba(this.palette.accent, 0.22);
        ctx.fill();
        if (active) {
          ctx.globalAlpha = 0.55;
          ctx.drawImage(this.sprites.highlight, x - 10, dotY - 10, 20, 20);
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  pulseBeat(accent = false) {
    const y = 50;
    this.spawnRing({
      x: this.width / 2,
      y,
      r0: 3,
      r1: accent ? 34 : 22,
      life: accent ? 0.7 : 0.55,
      alpha: accent ? 0.3 : 0.18,
      color: accent ? 'highlight' : 'accent',
      width: accent ? 1.6 : 1,
    });
  }

  /* -------------------------------------------------- labels */

  drawNoteLabels(now) {
    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.font = '500 11px "Segoe UI", "PingFang SC", sans-serif';
    for (const note of this.activeNotes.values()) {
      if (note.start > now || now > note.end) continue;
      if (note.instrument !== this.instrument.id) continue;
      const anchor = note.anchor;
      if (!anchor) continue;
      const jianpu = midiToJianpu(note.midi, this.keyOffset);
      const fade = Number.isFinite(note.end)
        ? clamp((note.end - now) / 0.3, 0, 1)
        : 1;
      const highT = clamp(
        (note.midi - this.instrument.minMidi) /
          Math.max(1, this.instrument.maxMidi - this.instrument.minMidi),
        0,
        1
      );
      ctx.fillStyle = rgba('#475570', (0.36 + highT * 0.25) * fade);
      const labelY = this.instrument.id === 'piano' ? anchor.y - this.height * (0.2 + highT * 0.15) : anchor.y - 22;
      ctx.fillText(`${jianpu}  ${midiToName(note.midi)}`, anchor.x, labelY);
    }
  }

  /* -------------------------------------------------- frame */

  tick() {
    if (!this.running) return;
    const now = this.clock();
    let dt = now - this.lastClock;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    dt = clamp(dt, 0, 0.06);
    this.lastClock = now;

    this.processPending(now);
    this.updateActiveNotes(now, dt);
    this.ambientParticles(dt, now);
    this.updateParticles(dt, now);
    this.updateRings(dt);

    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawAura(now);
    this.drawSmoke(now);
    this.drawInstrument(now);
    this.drawRings();
    this.drawParticles();
    this.drawNoteLabels(now);
    this.drawTimeline(now);

    this.frameHandle = requestAnimationFrame(this.tick);
  }
}
