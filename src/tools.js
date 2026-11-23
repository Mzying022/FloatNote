/**
 * FloatNote · 通用工具
 * 纯 ES Module，无任何第三方依赖。
 */

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function mapRange(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function midiToName(midi) {
  if (!Number.isFinite(midi)) return '—';
  const value = Math.round(midi);
  const octave = Math.floor(value / 12) - 1;
  return `${NOTE_NAMES[((value % 12) + 12) % 12]}${octave}`;
}

/** 解析 #RGB / #RRGGBB（可省略 #），失败返回 null。 */
export function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  let value = hex.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value.split('').map((c) => c + c).join('');
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

export function rgbToHex(r, g, b) {
  const toHex = (n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 支持 "169, 199, 238" / "rgb(169,199,238)" / "169 199 238"。 */
export function parseRgbString(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(
    /^\s*(?:rgba?\s*\(\s*)?(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*\)?\s*$/i
  );
  if (!match) return null;
  const r = Number(match[1]);
  const g = Number(match[2]);
  const b = Number(match[3]);
  if ([r, g, b].some((n) => n < 0 || n > 255)) return null;
  return { r, g, b };
}

export function rgbToHsl(r, g, b) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  s = clamp(s, 0, 1);
  l = clamp(l, 0, 1);
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

export function shiftColor(hex, { hue = 0, saturation = 0, lightness = 0 } = {}) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#a9c4ee';
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  return rgbToHex(
    ...Object.values(
      hslToRgb(hsl.h + hue, clamp(hsl.s + saturation, 0, 1), clamp(hsl.l + lightness, 0, 1))
    )
  );
}

export function mixColors(hexA, hexB, t = 0.5) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  if (!a || !b) return hexA || hexB || '#a9c4ee';
  return rgbToHex(lerp(a.r, b.r, t), lerp(a.g, b.g, t), lerp(a.b, b.b, t));
}

export function rgba(color, alpha = 1) {
  if (typeof color === 'string') {
    const rgb = hexToRgb(color);
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${clamp(alpha, 0, 1)})`;
  }
  if (color && typeof color === 'object') {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(alpha, 0, 1)})`;
  }
  return `rgba(255, 255, 255, ${clamp(alpha, 0, 1)})`;
}

export function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function debounce(fn, wait = 120) {
  let timer = 0;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function throttle(fn, wait = 80) {
  let last = 0;
  let timer = 0;
  return function throttled(...args) {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer);
      timer = 0;
      last = now;
      fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => {
        last = Date.now();
        timer = 0;
        fn.apply(this, args);
      }, remaining);
    }
  };
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function safeStorageGet(key, fallback = null) {
  try {
    const value = window.localStorage.getItem(key);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
    return true;
  } catch {
    return false;
  }
}

export function safeStorageRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略隐私模式 / 存储配额错误 */
  }
}

const scriptCache = new Map();

/** 动态加载经典脚本，失败时给出清晰错误。 */
export function loadScript(src, { timeout = 25000 } = {}) {
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不支持脚本加载'));
  }
  if (scriptCache.has(src)) return scriptCache.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`加载超时：${src}`));
    }, timeout);

    script.addEventListener('load', () => {
      finish(resolve);
    });
    script.addEventListener('error', () => {
      finish(reject, new Error(`无法加载：${src}`));
    });
    script.src = src;
    script.async = false;
    document.head.appendChild(script);
  });

  scriptCache.set(src, promise);
  promise.catch(() => scriptCache.delete(src));
  return promise;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 1200)),
      ]);
      return true;
    }
  } catch {
    /* 继续使用回退方案 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    target.closest('[contenteditable="true"]') !== null
  );
}

let idSeed = 0;
export function nextId(prefix = 'id') {
  idSeed += 1;
  return `${prefix}-${idSeed}`;
}
