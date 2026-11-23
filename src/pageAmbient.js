/**
 * FloatNote · 关于页 / 404 页的轻量环境光画布
 * 与主舞台共享同一套色彩和 screen 叠加语言，但不依赖音频引擎。
 */

import {
  clamp,
  hexToRgb,
  hslToRgb,
  mixColors,
  prefersReducedMotion,
  rgbToHex,
  rgbToHsl,
  rgba,
} from './tools.js';

const TAU = Math.PI * 2;

function makeGlow(color, size = 64) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const r = size / 2;
  const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
  gradient.addColorStop(0, rgba('#ffffff', 0.9));
  gradient.addColorStop(0.18, rgba(color, 0.66));
  gradient.addColorStop(0.52, rgba(color, 0.18));
  gradient.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

function makeSmoke(color, size = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.globalCompositeOperation = 'screen';
  for (const puff of [
    { x: 0.46, y: 0.5, r: 0.44, a: 0.5 },
    { x: 0.62, y: 0.38, r: 0.3, a: 0.36 },
    { x: 0.35, y: 0.62, r: 0.27, a: 0.26 },
  ]) {
    const cx = size * puff.x;
    const cy = size * puff.y;
    const radius = size * puff.r;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gradient.addColorStop(0, rgba(color, puff.a));
    gradient.addColorStop(0.56, rgba(color, puff.a * 0.4));
    gradient.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return canvas;
}

export function startAmbient(canvas, { color = '#a9c4ee' } = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) return () => {};
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return () => {};

  const reduced = prefersReducedMotion();
  const base = hexToRgb(color) || { r: 169, g: 196, b: 238 };
  const hsl = rgbToHsl(base.r, base.g, base.b);
  const deep = rgbToHex(
    ...Object.values(hslToRgb(hsl.h, clamp(hsl.s + 0.18, 0.2, 0.8), clamp(hsl.l - 0.13, 0.25, 0.72)))
  );
  const secondary = rgbToHex(
    ...Object.values(hslToRgb(hsl.h + 36, clamp(hsl.s * 0.92, 0.1, 0.75), clamp(hsl.l - 0.04, 0.2, 0.8)))
  );
  const highlight = mixColors(deep, '#ffffff', 0.48);
  const warm = mixColors(deep, '#e7b9c5', 0.42);
  const sprites = {
    base: makeGlow(deep),
    secondary: makeGlow(secondary),
    highlight: makeGlow(highlight),
  };
  const smokeSprites = {
    base: makeSmoke(deep),
    secondary: makeSmoke(secondary),
    warm: makeSmoke(warm),
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let raf = 0;
  let running = true;
  let last = performance.now();
  const start = last;

  const particles = Array.from({ length: reduced ? 160 : 440 }, () => ({ active: false }));
  const orbs = Array.from({ length: reduced ? 3 : 6 }, () => ({
    nx: 0.12 + Math.random() * 0.76,
    ny: 0.12 + Math.random() * 0.74,
    radius: 18 + Math.random() * 46,
    phase: Math.random() * TAU,
    speed: 0.12 + Math.random() * 0.22,
    alpha: 0.1 + Math.random() * 0.12,
  }));

  const smoke = Array.from({ length: reduced ? 3 : 5 }, (_, index) => ({
    nx: 0.12 + Math.random() * 0.76,
    ny: 0.12 + Math.random() * 0.7,
    radius: 0.18 + Math.random() * 0.24,
    phase: Math.random() * TAU,
    speed: 0.018 + Math.random() * 0.03,
    alpha: 0.1 + Math.random() * 0.1,
    sprite: ['base', 'secondary', 'warm'][index % 3],
  }));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    const nextDpr = clamp(window.devicePixelRatio || 1, 1, 2);
    if (nextWidth === width && nextHeight === height && nextDpr === dpr) return;
    width = nextWidth;
    height = nextHeight;
    dpr = nextDpr;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'screen';
  }

  function spawn(x, y, options = {}) {
    let slot = null;
    for (const particle of particles) {
      if (!particle.active) {
        slot = particle;
        break;
      }
    }
    if (!slot) return;
    Object.assign(slot, {
      active: true,
      x,
      y,
      vx: options.vx ?? (Math.random() - 0.5) * 10,
      vy: options.vy ?? -(4 + Math.random() * 12),
      age: 0,
      life: options.life ?? 6 + Math.random() * 8,
      size: options.size ?? 2.2 + Math.random() * 4.2,
      alpha: options.alpha ?? 0.62,
      sprite: options.sprite ?? (Math.random() < 0.58 ? 'base' : 'secondary'),
      wobble: options.wobble ?? 0.3 + Math.random() * 0.6,
      seed: Math.random() * TAU,
    });
  }

  function frame(now) {
    if (!running) return;
    const dt = clamp((now - last) / 1000, 0, 0.06);
    last = now;
    const time = (now - start) / 1000;
    resize();
    const target = reduced ? 48 : 130;
    let active = 0;
    for (const particle of particles) if (particle.active) active += 1;
    for (let n = 0; n < (active < target ? 2 : 0); n += 1) {
      const bokeh = Math.random() > 0.88;
      spawn(Math.random() * width, height * (0.28 + Math.random() * 0.72), {
        size: bokeh ? 7 + Math.random() * 10 : undefined,
        alpha: bokeh ? 0.24 : undefined,
        life: bokeh ? 12 + Math.random() * 8 : undefined,
      });
      active += 1;
    }

    for (const particle of particles) {
      if (!particle.active) continue;
      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.active = false;
        continue;
      }
      particle.x += (particle.vx + Math.sin((time + particle.seed) * 0.5) * 3) * dt;
      particle.y += particle.vy * dt;
      if (particle.y < -20 || particle.y > height + 20) particle.active = false;
    }

    ctx.clearRect(0, 0, width, height);

    const aura = ctx.createRadialGradient(
      width * 0.5,
      height * 0.42,
      0,
      width * 0.5,
      height * 0.42,
      Math.max(width, height) * 0.6
    );
    aura.addColorStop(0, rgba(highlight, 0.42));
    aura.addColorStop(0.46, rgba(deep, 0.18));
    aura.addColorStop(1, rgba(deep, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, width, height);

    // 中央的柔光柱，让大块留白有方向感。
    const columnX = width * (0.47 + Math.sin(time * 0.12) * 0.012);
    const columnWidth = Math.max(70, width * 0.2);
    const column = ctx.createLinearGradient(0, 0, 0, height);
    column.addColorStop(0, rgba(highlight, 0));
    column.addColorStop(0.3, rgba(highlight, 0.26));
    column.addColorStop(0.68, rgba(deep, 0.12));
    column.addColorStop(1, rgba(deep, 0));
    ctx.fillStyle = column;
    ctx.fillRect(columnX - columnWidth / 2, 0, columnWidth, height);

    for (const orb of orbs) {
      const x = width * (orb.nx + Math.sin(time * orb.speed + orb.phase) * 0.035);
      const y = height * (orb.ny + Math.cos(time * orb.speed * 0.8 + orb.phase) * 0.03);
      const r = orb.radius * (0.9 + Math.sin(time * orb.speed * 1.4 + orb.phase) * 0.12);
      ctx.globalAlpha = orb.alpha;
      ctx.drawImage(sprites.base, x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    for (const puff of smoke) {
      const x = width * (puff.nx + Math.sin(time * puff.speed + puff.phase) * 0.04);
      const y = height * (puff.ny + Math.cos(time * puff.speed * 0.85 + puff.phase) * 0.03);
      const size = Math.min(width, height) * puff.radius * 1.9;
      ctx.globalAlpha = puff.alpha;
      ctx.drawImage(smokeSprites[puff.sprite], x - size / 2, y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;

    for (const particle of particles) {
      if (!particle.active) continue;
      const lifeT = 1 - particle.age / particle.life;
      const size = particle.size * (0.7 + lifeT * 0.6);
      ctx.globalAlpha = particle.alpha * Math.pow(lifeT, 0.8);
      ctx.drawImage(
        sprites[particle.sprite] || sprites.highlight,
        particle.x - size,
        particle.y - size,
        size * 2,
        size * 2
      );
    }
    ctx.globalAlpha = 1;

    raf = requestAnimationFrame(frame);
  }

  const observer = 'ResizeObserver' in window ? new ResizeObserver(resize) : null;
  observer?.observe(canvas);
  window.addEventListener('resize', resize, { passive: true });
  resize();
  raf = requestAnimationFrame(frame);

  return function stopAmbient() {
    running = false;
    cancelAnimationFrame(raf);
    observer?.disconnect();
    window.removeEventListener('resize', resize);
  };
}
