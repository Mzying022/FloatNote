/**
 * FloatNote · 音频引擎
 *
 * - WebAudioFont 本地采样音色懒加载，失败时自动降级到内置合成音
 * - 统一 ADSR 包络、音量、混响预设
 * - 所有播放时刻统一使用 AudioContext.currentTime
 */

import {
  getInstrument,
  fitMidiToRange,
} from './instruments.js';
import { clamp, loadScript, midiToFreq, nextId } from './tools.js';

const PLAYER_LIBRARY = 'vendor/WebAudioFontPlayer.js';
const SOUNDFONT_TIMEOUT = 30000;
const DECODE_TIMEOUT = 18000;

const REVERB_SPACES = {
  long: { seconds: 3.6, decay: 2.6, damp: 0.55 },
  short: { seconds: 1.25, decay: 1.9, damp: 0.35 },
};

function isRunning(ctx) {
  return Boolean(ctx && ctx.state === 'running');
}

function applyEnvelope(param, start, peak, adsr, holdSeconds) {
  const attack = Math.max(0.002, adsr.attack);
  const decay = Math.max(0.002, adsr.decay);
  const sustain = clamp(adsr.sustain, 0.001, 1);
  const release = Math.max(0.02, adsr.release);
  const sustainLevel = peak * sustain;

  param.cancelScheduledValues(start);
  param.setValueAtTime(0.0001, start);
  param.linearRampToValueAtTime(peak, start + attack);
  const decayEnd = start + attack + decay;

  if (!Number.isFinite(holdSeconds)) {
    param.linearRampToValueAtTime(sustainLevel, decayEnd);
    return { releaseStart: null, release };
  }

  const releaseStart = start + Math.max(holdSeconds, attack * 0.6);
  if (decayEnd < releaseStart) {
    param.linearRampToValueAtTime(sustainLevel, decayEnd);
    param.setValueAtTime(sustainLevel, releaseStart);
  } else {
    const ratio = clamp((releaseStart - start - attack) / decay, 0, 1);
    const value = peak + (sustainLevel - peak) * ratio;
    param.linearRampToValueAtTime(Math.max(0.0001, value), releaseStart);
  }
  param.linearRampToValueAtTime(0.0001, releaseStart + release);
  return { releaseStart, release };
}

function releaseParam(param, at, release) {
  const t = Math.max(0.001, at);
  try {
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(t);
    } else {
      param.cancelScheduledValues(t);
      param.setValueAtTime(Math.max(0.0001, param.value || 0.0001), t);
    }
  } catch {
    /* 忽略不支持的自动化取消 */
  }
  param.linearRampToValueAtTime(0.0001, t + Math.max(0.02, release));
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.player = null;
    this.instrumentId = 'piano';
    this.mode = 'synth'; // 'synth' | 'soundfont'
    this.loadedInstrumentId = null;
    this.soundfontFailed = false;
    this.loading = new Map();
    this.voices = new Set();
    this.listeners = new Map();
    this.masterVolume = 0.78;
    this.instrumentVolume = 0.82;
    this.reverbEnabled = true;
    this.reverbMix = 0.3;
    this.reverbPreset = 'long';
    this.node = {};
    this.noiseBuffer = null;
    this.impulseCache = new Map();
    this.loadToken = 0;
  }

  /* -------------------------------------------------- events */

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type, detail = {}) {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(detail);
      } catch (error) {
        console.error('[FloatNote] audio event handler failed:', error);
      }
    }
  }

  /* -------------------------------------------------- context */

  get config() {
    return getInstrument(this.instrumentId);
  }

  get isUnlocked() {
    return isRunning(this.ctx);
  }

  clock() {
    if (this.ctx) return this.ctx.currentTime;
    return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  ensureContext() {
    if (this.ctx) return this.ctx;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error('当前浏览器不支持 WebAudio API，请使用 Chrome、Edge 或 Firefox 的现代版本。');
    }
    try {
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContextClass();
    }
    this.buildGraph();
    this.ctx.addEventListener?.('statechange', () => {
      this.emit('statechange', { state: this.ctx.state });
    });
    return this.ctx;
  }

  buildGraph() {
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = this.masterVolume;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -15;
    limiter.knee.value = 22;
    limiter.ratio.value = 3.2;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.26;

    const instrument = ctx.createGain();
    instrument.gain.value = this.instrumentVolume;

    const dry = ctx.createGain();
    dry.gain.value = 1;

    const convolver = ctx.createConvolver();
    const wet = ctx.createGain();
    wet.gain.value = this.reverbEnabled ? this.reverbMix : 0;

    instrument.connect(dry);
    dry.connect(master);
    instrument.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
    master.connect(limiter);
    limiter.connect(ctx.destination);

    this.node = { master, limiter, instrument, dry, convolver, wet };
    this.setReverbPreset(this.reverbPreset);
  }

  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        throw new Error('浏览器阻止了音频启动。请点击页面上任意按钮后再试。');
      }
    }
    if (ctx.state !== 'running') {
      throw new Error('音频引擎尚未启动，请点击播放或按下一个琴键。');
    }
    this.emit('unlock', { state: ctx.state });
    return true;
  }

  /* -------------------------------------------------- instrument / soundfont */

  setInstrument(id) {
    const next = getInstrument(id);
    if (next.id === this.instrumentId && this.mode === 'soundfont') {
      this.setReverbPreset(next.reverb);
      return next;
    }
    this.stopAll({ immediate: true });
    this.instrumentId = next.id;
    this.mode = 'synth';
    this.soundfontFailed = false;
    this.loadedInstrumentId = null;
    this.setReverbPreset(next.reverb);
    this.emit('instrument', { id: next.id, config: next });
    return next;
  }

  async loadCurrentInstrument({ force = false } = {}) {
    if (!force && this.loadedInstrumentId === this.instrumentId && this.mode === 'soundfont') {
      return { mode: 'soundfont', cached: true };
    }
    if (!force && this.soundfontFailed) {
      return { mode: 'synth', failed: true };
    }
    if (!force && this.loading.has(this.instrumentId)) {
      return this.loading.get(this.instrumentId);
    }

    if (!this.ctx) this.ensureContext();
    const instrument = this.config;
    const token = ++this.loadToken;
    this.emit('soundfontloading', {
      instrumentId: instrument.id,
      name: instrument.name,
      label: instrument.soundfont.label,
    });

    const promise = (async () => {
      try {
        if (!window.WebAudioFontPlayer) {
          await loadScript(PLAYER_LIBRARY, { timeout: 20000 });
        }
        if (!window.WebAudioFontPlayer) {
          throw new Error('WebAudioFont 播放器未能初始化');
        }
        if (!this.player) this.player = new window.WebAudioFontPlayer();

        await loadScript(instrument.soundfont.file, { timeout: SOUNDFONT_TIMEOUT });
        const preset = window[instrument.soundfont.variable];
        if (!preset || !Array.isArray(preset.zones) || preset.zones.length === 0) {
          throw new Error(`音色文件没有定义 ${instrument.soundfont.variable}`);
        }

        this.player.adjustPreset(this.ctx, preset);
        await this.waitForDecoded(preset, token);

        // 采样本身的 AHDSR 关闭，统一由外层 ADSR 控制。
        for (const zone of preset.zones) {
          zone.ahdsr = [{ duration: 0, volume: 1 }];
        }

        if (token !== this.loadToken || this.instrumentId !== instrument.id) {
          return { mode: 'synth', stale: true };
        }

        this.mode = 'soundfont';
        this.soundfontFailed = false;
        this.loadedInstrumentId = instrument.id;
        this.loading.delete(instrument.id);
        this.emit('soundfontready', {
          instrumentId: instrument.id,
          name: instrument.name,
          label: instrument.soundfont.label,
        });
        return { mode: 'soundfont' };
      } catch (error) {
        if (token !== this.loadToken || this.instrumentId !== instrument.id) {
          return { mode: 'synth', stale: true };
        }
        this.mode = 'synth';
        this.soundfontFailed = true;
        this.loadedInstrumentId = null;
        this.loading.delete(instrument.id);
        const message = `「${instrument.name}」音色加载失败，已切换到内置合成音色。`;
        console.warn('[FloatNote] soundfont fallback:', error);
        this.emit('fallback', { instrumentId: instrument.id, message, error });
        return { mode: 'synth', error };
      } finally {
        this.loading.delete(instrument.id);
      }
    })();

    this.loading.set(instrument.id, promise);
    return promise;
  }

  async waitForDecoded(preset, token) {
    const started = performance.now();
    while (performance.now() - started < DECODE_TIMEOUT) {
      if (token !== this.loadToken) return;
      const decoded = preset.zones.every((zone) => Boolean(zone.buffer));
      if (decoded) return;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw new Error('音色解码超时');
  }

  async retrySoundfont() {
    this.soundfontFailed = false;
    this.mode = 'synth';
    this.loadedInstrumentId = null;
    return this.loadCurrentInstrument({ force: true });
  }

  /* -------------------------------------------------- volume / reverb */

  setMasterVolume(value) {
    this.masterVolume = clamp(Number(value) || 0, 0, 1);
    if (this.node.master) {
      this.node.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
    }
  }

  setInstrumentVolume(value) {
    this.instrumentVolume = clamp(Number(value) || 0, 0, 1);
    if (this.node.instrument) {
      this.node.instrument.gain.setTargetAtTime(this.instrumentVolume, this.ctx.currentTime, 0.02);
    }
  }

  setReverbEnabled(enabled) {
    this.reverbEnabled = Boolean(enabled);
    if (this.node.wet) {
      this.node.wet.gain.setTargetAtTime(
        this.reverbEnabled ? this.reverbMix : 0,
        this.ctx.currentTime,
        0.03
      );
    }
  }

  setReverbMix(value) {
    this.reverbMix = clamp(Number(value) || 0, 0, 1);
    if (this.node.wet) {
      this.node.wet.gain.setTargetAtTime(
        this.reverbEnabled ? this.reverbMix : 0,
        this.ctx.currentTime,
        0.03
      );
    }
  }

  setReverbPreset(preset) {
    const key = preset === 'short' ? 'short' : 'long';
    this.reverbPreset = key;
    if (!this.ctx || !this.node.convolver) return;
    let impulse = this.impulseCache.get(key);
    if (!impulse) {
      impulse = this.createImpulse(REVERB_SPACES[key]);
      this.impulseCache.set(key, impulse);
    }
    this.node.convolver.buffer = impulse;
  }

  createImpulse({ seconds, decay, damp }) {
    const rate = this.ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = buffer.getChannelData(channel);
      let smoothed = 0;
      for (let i = 0; i < length; i += 1) {
        const t = i / length;
        const noise = Math.random() * 2 - 1;
        smoothed = smoothed * damp + noise * (1 - damp);
        data[i] = smoothed * Math.pow(1 - t, decay) * (1 - t * 0.25);
      }
    }
    return buffer;
  }

  getNoiseBuffer() {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.floor(this.ctx.sampleRate * 2);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  /* -------------------------------------------------- notes */

  /**
   * @param {number} midi
   * @param {{when?: number, duration?: number|null, velocity?: number, fit?: boolean, source?: string}} options
   */
  playNote(midi, options = {}) {
    if (!isRunning(this.ctx)) return null;
    const config = this.config;
    const sourceMidi = Math.round(Number(midi));
    if (!Number.isFinite(sourceMidi)) return null;

    let finalMidi = sourceMidi;
    let octaves = 0;
    let adjusted = false;
    if (options.fit !== false) {
      const fit = fitMidiToRange(sourceMidi, config.minMidi, config.maxMidi);
      if (fit.midi === null) {
        return {
          muted: true,
          reason: `${config.name}的音域为 ${config.rangeLabel}，这个音符无法适配。`,
        };
      }
      finalMidi = fit.midi;
      octaves = fit.octaves;
      adjusted = fit.adjusted;
    }
    if (finalMidi < 0 || finalMidi > 127) return null;

    const now = this.ctx.currentTime;
    const when = Math.max(Number(options.when) || now, now);
    const duration = Number.isFinite(options.duration) ? Math.max(0.035, options.duration) : null;
    const velocity = clamp(Number(options.velocity) || 0.78, 0.05, 1);
    const useSoundfont =
      this.mode === 'soundfont' &&
      this.player &&
      window[config.soundfont.variable] &&
      this.loadedInstrumentId === config.id;

    let voice = null;
    if (useSoundfont) {
      voice = this.createSoundfontVoice(finalMidi, when, duration, velocity, config);
    }
    if (!voice) {
      voice = this.createSynthVoice(finalMidi, when, duration, velocity, config);
    }
    if (!voice) return null;

    voice.id = nextId('voice');
    voice.instrumentId = config.id;
    voice.midi = finalMidi;
    voice.sourceMidi = sourceMidi;
    voice.octaves = octaves;
    voice.adjusted = adjusted;
    voice.velocity = velocity;
    voice.source = options.source || 'live';
    voice.startedAt = when;
    voice.ended = false;
    voice.cleanup = () => {
      if (voice.ended) return;
      voice.ended = true;
      this.voices.delete(voice);
      try {
        voice.noteGain?.disconnect();
      } catch {
        /* noop */
      }
    };
    const endedNode = voice.sourceNode || voice.primaryOsc;
    if (endedNode) {
      endedNode.addEventListener('ended', () => voice.cleanup(), { once: true });
    }
    // WebAudioFont 的 envelope 数组不会被内部回收；长期演奏时修剪已经结束的条目。
    if (this.player?.envelopes?.length > 160) {
      const nowTime = this.ctx.currentTime;
      this.player.envelopes = this.player.envelopes.filter(
        (envelope) =>
          !Number.isFinite(envelope.when) ||
          envelope.when + envelope.duration + 0.5 > nowTime
      );
    }
    this.voices.add(voice);
    this.emit('note', {
      voice,
      midi: finalMidi,
      sourceMidi,
      adjusted,
      octaves,
      velocity,
      source: voice.source,
      when,
      duration,
      instrumentId: config.id,
    });
    return voice;
  }

  createSoundfontVoice(midi, when, duration, velocity, config) {
    const preset = window[config.soundfont.variable];
    const ctx = this.ctx;
    const noteGain = ctx.createGain();
    noteGain.connect(this.node.instrument);

    const adsr = config.adsr;
    const release = Math.max(0.05, adsr.release);
    const hold = duration === null ? null : duration;
    const peak = clamp(velocity * 0.9, 0.02, 1);
    applyEnvelope(noteGain.gain, when, peak, adsr, Number.isFinite(hold) ? hold : Number.POSITIVE_INFINITY);

    const sourceDuration = duration === null ? 60 : duration + release + 0.12;
    let envelope = null;
    try {
      envelope = this.player.queueWaveTable(
        ctx,
        noteGain,
        preset,
        when,
        midi,
        sourceDuration,
        1
      );
    } catch (error) {
      console.warn('[FloatNote] queueWaveTable failed:', error);
    }
    if (!envelope) {
      try {
        noteGain.disconnect();
      } catch {
        /* noop */
      }
      return null;
    }

    const sourceNode = envelope.audioBufferSourceNode;
    let stopped = false;
    const stopAt = (at, releaseSeconds = release) => {
      if (stopped) return;
      stopped = true;
      const t = Math.max(at, this.ctx.currentTime);
      releaseParam(noteGain.gain, t, releaseSeconds);
      try {
        sourceNode?.stop(t + releaseSeconds + 0.04);
      } catch {
        /* 已经停止 */
      }
    };

    if (Number.isFinite(hold)) {
      // 采样源的 stop 已由播放器排好；这里只负责外层包络。
    }

    if (sourceNode) {
      sourceNode.addEventListener(
        'ended',
        () => {
          try {
            envelope.disconnect();
          } catch {
            /* noop */
          }
          try {
            noteGain.disconnect();
          } catch {
            /* noop */
          }
        },
        { once: true }
      );
    }

    return {
      midi,
      mode: 'soundfont',
      noteGain,
      envelope,
      sourceNode,
      stop: stopAt,
      cut(at = this.ctx.currentTime) {
        stopAt(at, 0.045);
      },
    };
  }

  createSynthVoice(midi, when, duration, velocity, config) {
    const ctx = this.ctx;
    const synth = config.synth;
    const noteGain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const adsr = config.adsr;
    const release = Math.max(0.05, adsr.release);
    const peak = clamp(velocity * 0.34, 0.01, 0.6);

    filter.type = synth.filter?.type || 'lowpass';
    filter.Q.value = synth.filter?.q ?? 0.7;
    const baseFrequency = Math.max(180, Math.min(16000, synth.filter?.frequency || 3200));
    filter.frequency.setValueAtTime(
      Math.min(18000, baseFrequency + (synth.filter?.envAmount || 0)),
      when
    );
    filter.frequency.exponentialRampToValueAtTime(
      baseFrequency,
      when + Math.max(0.05, synth.filter?.envDecay || 0.25)
    );

    const hold = duration === null ? Number.POSITIVE_INFINITY : duration;
    applyEnvelope(noteGain.gain, when, peak, adsr, hold);
    filter.connect(noteGain);
    noteGain.connect(this.node.instrument);

    const oscillators = [];
    const gains = [];
    const frequency = midiToFreq(midi);
    for (const partial of synth.partials) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = partial.type || 'sine';
      osc.frequency.setValueAtTime(frequency * (partial.ratio || 1), when);
      osc.detune.setValueAtTime(partial.detune || 0, when);
      gain.gain.value = partial.gain ?? 1;
      osc.connect(gain);
      gain.connect(filter);
      oscillators.push(osc);
      gains.push(gain);
    }

    let lfo = null;
    let lfoGain = null;
    if (synth.vibrato) {
      lfo = ctx.createOscillator();
      lfoGain = ctx.createGain();
      lfo.type = 'sine';
      lfo.frequency.value = synth.vibrato.rate || 5;
      lfoGain.gain.value = synth.vibrato.depth || 4;
      lfo.connect(lfoGain);
      for (const osc of oscillators) lfoGain.connect(osc.detune);
    }

    let noise = null;
    let noiseGain = null;
    if (config.family === 'wind' || config.family === 'reed') {
      noise = ctx.createBufferSource();
      noise.buffer = this.getNoiseBuffer();
      noise.loop = true;
      noiseGain = ctx.createGain();
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.frequency.value = config.family === 'reed' ? 1800 : 3200;
      noiseFilter.Q.value = 0.7;
      noiseGain.gain.setValueAtTime(0.0001, when);
      noiseGain.gain.linearRampToValueAtTime(0.035, when + 0.02);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.35);
      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(noteGain);
    }

    const sourceStopTime = Number.isFinite(duration)
      ? when + duration + release + 0.08
      : when + 90;

    for (const osc of oscillators) {
      try {
        osc.start(when);
        osc.stop(sourceStopTime);
      } catch {
        /* noop */
      }
    }
    if (lfo) {
      try {
        lfo.start(when);
        lfo.stop(sourceStopTime);
      } catch {
        /* noop */
      }
    }
    if (noise) {
      try {
        noise.start(when);
        noise.stop(sourceStopTime);
      } catch {
        /* noop */
      }
    }

    let stopped = false;
    const stopAt = (at, releaseSeconds = release) => {
      if (stopped) return;
      stopped = true;
      const t = Math.max(at, this.ctx.currentTime);
      releaseParam(noteGain.gain, t, releaseSeconds);
      for (const osc of oscillators) {
        try {
          osc.stop(t + releaseSeconds + 0.04);
        } catch {
          /* noop */
        }
      }
      if (lfo) {
        try {
          lfo.stop(t + releaseSeconds + 0.04);
        } catch {
          /* noop */
        }
      }
      if (noise) {
        try {
          noise.stop(t + releaseSeconds + 0.04);
        } catch {
          /* noop */
        }
      }
    };

    const primary = oscillators[0];
    if (primary) {
      primary.addEventListener(
        'ended',
        () => {
          try {
            filter.disconnect();
            noteGain.disconnect();
            for (const gain of gains) gain.disconnect();
            lfoGain?.disconnect();
            noiseGain?.disconnect();
          } catch {
            /* noop */
          }
        },
        { once: true }
      );
    }

    return {
      midi,
      mode: 'synth',
      noteGain,
      primaryOsc: primary,
      stop: stopAt,
      cut(at = this.ctx.currentTime) {
        stopAt(at, 0.04);
      },
    };
  }

  stopAll({ immediate = false } = {}) {
    const voices = [...this.voices];
    for (const voice of voices) {
      try {
        if (immediate && typeof voice.cut === 'function') voice.cut(this.ctx?.currentTime || 0);
        else if (typeof voice.stop === 'function') voice.stop(this.ctx?.currentTime || 0);
      } catch (error) {
        console.warn('[FloatNote] stop voice failed:', error);
      }
    }
    this.voices.clear();
    if (this.player && this.ctx) {
      try {
        this.player.cancelQueue(this.ctx);
      } catch {
        /* noop */
      }
    }
  }

  /* -------------------------------------------------- metronome */

  click(when = this.clock(), accent = false) {
    if (!isRunning(this.ctx)) return;
    const ctx = this.ctx;
    const t = Math.max(Number(when) || ctx.currentTime, ctx.currentTime);
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(accent ? 1180 : 760, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(accent ? 0.34 : 0.2, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(gain);
    gain.connect(this.node.master);
    osc.start(t);
    osc.stop(t + 0.12);
    osc.addEventListener(
      'ended',
      () => {
        try {
          gain.disconnect();
        } catch {
          /* noop */
        }
      },
      { once: true }
    );
  }

  /* -------------------------------------------------- status */

  getModeLabel() {
    const config = this.config;
    if (this.mode === 'soundfont') return config.soundfont.label;
    if (this.soundfontFailed) return config.fallbackLabel;
    if (this.loading.has(this.instrumentId)) return '内置合成音色（采样加载中）';
    return config.fallbackLabel;
  }

  getStatus() {
    return {
      instrumentId: this.instrumentId,
      mode: this.mode,
      soundfontFailed: this.soundfontFailed,
      unlocked: this.isUnlocked,
      label: this.getModeLabel(),
    };
  }
}

export const audioEngine = new AudioEngine();
