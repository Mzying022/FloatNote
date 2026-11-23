/**
 * FloatNote · 乐器配置
 * 音域、混响、音色文件、合成兜底参数集中在这里，便于替换和调参。
 */

export const INSTRUMENTS = Object.freeze({
  piano: {
    id: 'piano',
    name: '钢琴',
    en: 'Piano',
    color: '#9db9e8',
    minMidi: 21,
    maxMidi: 108,
    rangeLabel: 'A0 – C8',
    rangeHint: '88 键完整音域',
    family: 'keyboard',
    timbre: '颗粒分明 · 明亮',
    reverb: 'long',
    reverbLabel: '长混响',
    genreAffinity: { 古典: 3, 民乐: 1, 通俗: 2 },
    keyHint: 'A–J 中音 1–7 · W E T Y U 半音 · Shift / Ctrl 八度',
    tableKeyMap: 'A–J = 1–7；W E T Y U = #1 #2 #4 #5 #6；Shift/Ctrl = 八度',
    soundfont: {
      file: 'vendor/soundfonts/0000_FluidR3_GM_sf2_file.js',
      variable: '_tone_0000_FluidR3_GM_sf2_file',
      label: 'FluidR3 大钢琴',
    },
    fallbackLabel: '内置合成钢琴',
    adsr: { attack: 0.004, decay: 0.55, sustain: 0.3, release: 0.75 },
    synth: {
      partials: [
        { type: 'triangle', ratio: 1, gain: 0.9, detune: 0 },
        { type: 'sine', ratio: 2, gain: 0.22, detune: 4 },
        { type: 'sine', ratio: 3, gain: 0.08, detune: -5 },
      ],
      filter: { type: 'lowpass', frequency: 4200, q: 0.6, envAmount: 1800, envDecay: 0.5 },
    },
    visual: {
      name: '垂直光柱',
      description: '粒子从键面上升，音越高光柱越细、越亮。',
    },
  },

  guitar: {
    id: 'guitar',
    name: '吉他',
    en: 'Guitar',
    color: '#e3b7a8',
    minMidi: 40,
    maxMidi: 88,
    rangeLabel: 'E2 – E6',
    rangeHint: '标准调弦 E A D G B E',
    family: 'pluck',
    timbre: '温暖 · 木质',
    reverb: 'short',
    reverbLabel: '短混响',
    genreAffinity: { 古典: 1, 民乐: 2, 通俗: 3 },
    keyHint: '1–6 空弦 · QWERTY / ASDFGH / ZXCVBN 前三弦 · Shift + 字母 4–6 弦',
    tableKeyMap: '1–6 = 空弦；Q W E R T Y / A S D F G H / Z X C V B N = 1–3 弦品格；Shift+字母 = 4–6 弦品格',
    soundfont: {
      file: 'vendor/soundfonts/0240_FluidR3_GM_sf2_file.js',
      variable: '_tone_0240_FluidR3_GM_sf2_file',
      label: 'FluidR3 尼龙弦吉他',
    },
    fallbackLabel: '内置合成吉他',
    adsr: { attack: 0.003, decay: 0.32, sustain: 0.16, release: 0.45 },
    synth: {
      partials: [
        { type: 'triangle', ratio: 1, gain: 0.9, detune: 0 },
        { type: 'sine', ratio: 2, gain: 0.35, detune: 7 },
        { type: 'sawtooth', ratio: 1, gain: 0.08, detune: -4 },
      ],
      filter: { type: 'lowpass', frequency: 3000, q: 1.1, envAmount: 2200, envDecay: 0.25 },
    },
    visual: {
      name: '水平擦弦拖尾',
      description: '光沿琴弦横向滑动，低音拖尾更长、更柔和。',
    },
  },

  violin: {
    id: 'violin',
    name: '小提琴',
    en: 'Violin',
    color: '#c5a9dd',
    minMidi: 55,
    maxMidi: 100,
    rangeLabel: 'G3 – E7',
    rangeHint: '四弦 · 连贯歌唱性',
    family: 'bowed',
    timbre: '绵长 · 柔亮',
    reverb: 'long',
    reverbLabel: '长混响',
    genreAffinity: { 古典: 3, 民乐: 2, 通俗: 1 },
    keyHint: 'A–J = 1–7 · Shift 高把位 · Ctrl 半音',
    tableKeyMap: 'A–J = 1–7；Shift = 高把位；Ctrl = 半音；长按延音',
    soundfont: {
      file: 'vendor/soundfonts/0400_FluidR3_GM_sf2_file.js',
      variable: '_tone_0400_FluidR3_GM_sf2_file',
      label: 'FluidR3 小提琴',
    },
    fallbackLabel: '内置合成弦乐',
    adsr: { attack: 0.12, decay: 0.24, sustain: 0.78, release: 0.55 },
    synth: {
      partials: [
        { type: 'sawtooth', ratio: 1, gain: 0.72, detune: 0 },
        { type: 'sawtooth', ratio: 1, gain: 0.36, detune: 7 },
        { type: 'triangle', ratio: 2, gain: 0.12, detune: -5 },
      ],
      filter: { type: 'lowpass', frequency: 3600, q: 0.8, envAmount: 900, envDecay: 0.4 },
      vibrato: { rate: 5.2, depth: 5 },
    },
    visual: {
      name: '指板纵向流光',
      description: '光沿指板流动，高把位粒子更密、更亮。',
    },
  },

  sax: {
    id: 'sax',
    name: '萨克斯',
    en: 'Sax',
    color: '#e4b8c4',
    minMidi: 49,
    maxMidi: 84,
    rangeLabel: 'Db3 – C6',
    rangeHint: '中音萨克斯 · 气息感',
    family: 'reed',
    timbre: '醇厚 · 微沙',
    reverb: 'short',
    reverbLabel: '短混响',
    genreAffinity: { 古典: 1, 民乐: 1, 通俗: 3 },
    keyHint: 'A–J 基础指法 · Shift 超吹 · Ctrl 半音',
    tableKeyMap: 'A–J = 1–7；Shift = 超吹高音；Ctrl = 半音；长按延音',
    soundfont: {
      file: 'vendor/soundfonts/0650_FluidR3_GM_sf2_file.js',
      variable: '_tone_0650_FluidR3_GM_sf2_file',
      label: 'FluidR3 中音萨克斯',
    },
    fallbackLabel: '内置合成萨克斯',
    adsr: { attack: 0.045, decay: 0.18, sustain: 0.72, release: 0.32 },
    synth: {
      partials: [
        { type: 'sawtooth', ratio: 1, gain: 0.75, detune: 0 },
        { type: 'square', ratio: 1, gain: 0.16, detune: -6 },
        { type: 'sine', ratio: 2, gain: 0.1, detune: 3 },
      ],
      filter: { type: 'lowpass', frequency: 2200, q: 1.3, envAmount: 1300, envDecay: 0.2 },
      vibrato: { rate: 4.6, depth: 6 },
    },
    visual: {
      name: '锥形气流',
      description: '气流从吹口向前喷射，随音符时值逐渐衰减。',
    },
  },

  flute: {
    id: 'flute',
    name: '笛子',
    en: 'Flute',
    color: '#a9d6c9',
    minMidi: 60,
    maxMidi: 96,
    rangeLabel: 'C4 – C7',
    rangeHint: '清亮 · 空灵',
    family: 'wind',
    timbre: '通透 · 轻灵',
    reverb: 'short',
    reverbLabel: '短混响',
    genreAffinity: { 古典: 2, 民乐: 3, 通俗: 2 },
    keyHint: 'A–J 基础指法 · Shift 超吹 · Ctrl 半音',
    tableKeyMap: 'A–J = 1–7；Shift = 超吹；Ctrl = 半音；长按延音',
    soundfont: {
      file: 'vendor/soundfonts/0730_FluidR3_GM_sf2_file.js',
      variable: '_tone_0730_FluidR3_GM_sf2_file',
      label: 'FluidR3 长笛',
    },
    fallbackLabel: '内置合成笛声',
    adsr: { attack: 0.06, decay: 0.16, sustain: 0.68, release: 0.35 },
    synth: {
      partials: [
        { type: 'sine', ratio: 1, gain: 0.9, detune: 0 },
        { type: 'sine', ratio: 2, gain: 0.18, detune: 2 },
        { type: 'triangle', ratio: 3, gain: 0.05, detune: -3 },
      ],
      filter: { type: 'lowpass', frequency: 5200, q: 0.5, envAmount: 800, envDecay: 0.3 },
      vibrato: { rate: 5.8, depth: 4 },
    },
    visual: {
      name: '指孔双侧迸发',
      description: '指孔向两侧迸出光点，高音区更亮、更快。',
    },
  },
});

export const INSTRUMENT_ORDER = Object.freeze(['piano', 'guitar', 'violin', 'sax', 'flute']);

export const DEFAULT_INSTRUMENT = 'piano';

export function getInstrument(id) {
  return INSTRUMENTS[id] || INSTRUMENTS[DEFAULT_INSTRUMENT];
}

/** 把任意 MIDI 音移入音域；优先向下移八度。 */
export function fitMidiToRange(midi, minMidi, maxMidi) {
  let value = Math.round(Number(midi));
  if (!Number.isFinite(value)) return { midi: null, octaves: 0, adjusted: false };
  let octaves = 0;
  let guard = 0;
  while (value < minMidi && guard < 8) {
    value += 12;
    octaves += 1;
    guard += 1;
  }
  while (value > maxMidi && guard < 8) {
    value -= 12;
    octaves -= 1;
    guard += 1;
  }
  if (value < minMidi || value > maxMidi) {
    return { midi: null, octaves: 0, adjusted: false };
  }
  return { midi: value, octaves, adjusted: octaves !== 0 };
}

export function midiInRange(midi, instrument) {
  return midi >= instrument.minMidi && midi <= instrument.maxMidi;
}

export function instrumentRangeWidth(instrument) {
  return instrument.maxMidi - instrument.minMidi;
}
