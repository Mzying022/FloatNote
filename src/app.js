/**
 * FloatNote · 应用编排
 * 负责 UI、简谱载入、播放调度、键盘映射、主题面板与搜谱/编配交互。
 */

import { StageRenderer } from './canvasRender.js';
import { audioEngine } from './audioEngine.js';
import {
  DEFAULT_SCORE,
  buildTimeline,
  formatNoteToken,
  midiToJianpu,
  noteToMidi,
  parseScore,
} from './scoreParser.js';
import {
  INSTRUMENTS,
  INSTRUMENT_ORDER,
  fitMidiToRange,
  getInstrument,
} from './instruments.js';
import { arrangeScore } from './autoArranger.js';
import { buildChordTrack } from './chords.js';
import {
  clamp,
  copyText,
  debounce,
  escapeHtml,
  formatClock,
  hexToRgb,
  isEditableTarget,
  midiToName,
  nextId,
  parseRgbString,
  rgbToHex,
  safeStorageGet,
  safeStorageSet,
} from './tools.js';

const THEME_KEY = 'floatnote.theme.v1';
const LIBRARY_KEY = 'floatnote.library.v1';
const DEFAULT_THEME = Object.freeze({
  color: '#a9c4ee',
  brightness: 1,
  density: 1,
});
const LOOKAHEAD_SECONDS = 0.42;
const SCHEDULER_INTERVAL_MS = 25;
const PRE_ROLL_SECONDS = 0.13;
const LONG_PRESS_MS = 380;
const MAX_PREVIEW_NOTES = 420;

const AI_PROMPT_TEXT = `请按照下面这套简谱规范输出乐谱文本，只输出乐谱，不要额外解释、不要markdown、不要五线谱、不要图片、不要注释。
格式规则：
1. 第一行写明调号、拍号、速度，格式：1=C 4/4 ♩=80；如果没有指定，默认使用 1=C 4/4 ♩=80
2. 基础音符：1 2 3 4 5 6 7
3. 低音标记：数字后面加英文句号，例如 1. 代表低音1
4. 高音标记：数字后面加英文单引号，例如 1' 代表高音1
5. 升半音标记：# + 音符，例如 #1 #2 #4
6. 时值规则：默认四分音符；1- 为二分音符；1_ 为八分音符
7. 延音标记：波浪号 ~，例如 5~
8. 小节之间用竖线 | 分隔，音符之间用空格隔开
9. 不支持装饰音、滑音、反复记号、房子记号、强弱记号，遇到这类记号请简化为普通音符与时值
示例：1=C 4/4 ♩=80
5 3 5 | 6 5 3 | 2 3 5 1' | 1' - |`;

const SEARCH_ENGINES = {
  bing: { name: '必应', url: 'https://www.bing.com/search?q=' },
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
};

const PIANO_MAIN = {
  KeyA: 1,
  KeyS: 2,
  KeyD: 3,
  KeyF: 4,
  KeyG: 5,
  KeyH: 6,
  KeyJ: 7,
};
const PIANO_SHARP = {
  KeyW: 1,
  KeyE: 2,
  KeyT: 4,
  KeyY: 5,
  KeyU: 6,
};
const LETTER_DEGREES = {
  KeyA: 1,
  KeyS: 2,
  KeyD: 3,
  KeyF: 4,
  KeyG: 5,
  KeyH: 6,
  KeyJ: 7,
};
const GUITAR_TUNING = [64, 59, 55, 50, 45, 40]; // 1 弦（高音 E）到 6 弦
const GUITAR_OPEN = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
};
const GUITAR_ROWS = [
  { string: 1, keys: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY'], mod: 'base' },
  { string: 2, keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'], mod: 'base' },
  { string: 3, keys: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN'], mod: 'base' },
  { string: 4, keys: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY'], mod: 'shift' },
  { string: 5, keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH'], mod: 'shift' },
  { string: 6, keys: ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN'], mod: 'shift' },
];

const ICONS = {
  piano:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M8 4.5v8M12 4.5v8M16 4.5v8"/></svg>',
  guitar:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3.5l6 6"/><path d="M16.2 5.2l-4.4 4.4"/><path d="M11.8 9.6c-2 2-1.2 4.4-3.3 6.5a3.6 3.6 0 1 0 5 5c2.1-2.1 4.5-1.3 6.5-3.3"/><circle cx="11.2" cy="16.4" r="2.2"/></svg>',
  violin:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5v5"/><path d="M10 4.5h4"/><path d="M12 7.5c-2 0-3 1.5-3 3.4 0 1.1.5 1.9 1 2.6-1.2 1.2-2 2.6-2 4.2a4 4 0 0 0 8 0c0-1.6-.8-3-2-4.2.5-.7 1-1.5 1-2.6 0-1.9-1-3.4-3-3.4z"/><path d="M9 13.5l6 6"/></svg>',
  sax:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5l3.5 3.5c2.4 2.4 1.4 5.6 3.8 8s5.6 1.4 7 2.8"/><path d="M17.5 16.5c1.5 1.5 1.3 3.2.2 4.3-1.1 1.1-2.8 1.3-4.3-.2"/><circle cx="9.2" cy="10.2" r="1.1"/><circle cx="12.2" cy="13.4" r="1.1"/></svg>',
  flute:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12h19"/><circle cx="7" cy="11.2" r="1.1"/><circle cx="10.5" cy="11.2" r="1.1"/><circle cx="14" cy="11.2" r="1.1"/><circle cx="17.5" cy="11.2" r="1.1"/><path d="M2.5 12l2.2 2.2M21.5 12l-2.2-2.2"/></svg>',
};

const els = {
  audioWakeBtn: document.getElementById('audioWakeBtn'),
  audioStatus: document.getElementById('audioStatus'),
  audioStatusText: document.getElementById('audioStatusText'),
  panelToggle: document.getElementById('panelToggle'),
  controlPanel: document.getElementById('controlPanel'),
  panelClose: document.getElementById('panelClose'),
  panelBackdrop: document.getElementById('panelBackdrop'),

  instrumentGrid: document.getElementById('instrumentGrid'),
  rangeLabel: document.getElementById('rangeLabel'),
  rangeHint: document.getElementById('rangeHint'),
  retrySoundfontBtn: document.getElementById('retrySoundfontBtn'),
  soundModeLabel: document.getElementById('soundModeLabel'),

  tempoRange: document.getElementById('tempoRange'),
  tempoValue: document.getElementById('tempoValue'),
  masterVolume: document.getElementById('masterVolume'),
  masterVolumeValue: document.getElementById('masterVolumeValue'),
  instrumentVolume: document.getElementById('instrumentVolume'),
  instrumentVolumeValue: document.getElementById('instrumentVolumeValue'),
  reverbMix: document.getElementById('reverbMix'),
  reverbMixValue: document.getElementById('reverbMixValue'),
  reverbToggle: document.getElementById('reverbToggle'),
  reverbPreset: document.getElementById('reverbPreset'),
  octaveSelector: document.getElementById('octaveSelector'),

  particleBrightness: document.getElementById('particleBrightness'),
  particleDensity: document.getElementById('particleDensity'),
  brightnessValue: document.getElementById('brightnessValue'),
  densityValue: document.getElementById('densityValue'),
  themeColor: document.getElementById('themeColor'),
  colorSwatch: document.getElementById('colorSwatch'),
  hexInput: document.getElementById('hexInput'),
  rgbInput: document.getElementById('rgbInput'),
  copyColorBtn: document.getElementById('copyColorBtn'),
  resetThemeBtn: document.getElementById('resetThemeBtn'),
  themeJqStatus: document.getElementById('themeJqStatus'),
  instrumentTableWrap: document.getElementById('instrumentTableWrap'),

  stageInstrument: document.getElementById('stageInstrument'),
  stageVisual: document.getElementById('stageVisual'),
  keyChip: document.getElementById('keyChip'),
  meterChip: document.getElementById('meterChip'),
  bpmChip: document.getElementById('bpmChip'),
  stageCanvas: document.getElementById('stageCanvas'),
  noteReadout: document.getElementById('noteReadout'),
  stageHint: document.getElementById('stageHint'),
  stageLoading: document.getElementById('stageLoading'),
  stageEffectName: document.getElementById('stageEffectName'),
  keyboardStrip: document.getElementById('keyboardStrip'),

  playBtn: document.getElementById('playBtn'),
  playIcon: document.getElementById('playIcon'),
  playLabel: document.getElementById('playLabel'),
  stopBtn: document.getElementById('stopBtn'),
  metronomeBtn: document.getElementById('metronomeBtn'),
  loopBtn: document.getElementById('loopBtn'),
  currentTime: document.getElementById('currentTime'),
  totalTime: document.getElementById('totalTime'),
  loopChip: document.getElementById('loopChip'),
  progressShell: document.getElementById('progressShell'),
  progressFill: document.getElementById('progressFill'),
  progressAb: document.getElementById('progressAb'),
  progressRange: document.getElementById('progressRange'),
  setABtn: document.getElementById('setABtn'),
  setBBtn: document.getElementById('setBBtn'),
  abLoopBtn: document.getElementById('abLoopBtn'),
  clearABtn: document.getElementById('clearABtn'),
  abStatus: document.getElementById('abStatus'),

  scoreInput: document.getElementById('scoreInput'),
  songTitleInput: document.getElementById('songTitleInput'),
  saveSongBtn: document.getElementById('saveSongBtn'),
  libraryList: document.getElementById('libraryList'),
  libraryCount: document.getElementById('libraryCount'),
  chordsToggle: document.getElementById('chordsToggle'),
  chordVolume: document.getElementById('chordVolume'),
  chordVolumeValue: document.getElementById('chordVolumeValue'),
  chordInfo: document.getElementById('chordInfo'),
  parseBtn: document.getElementById('parseBtn'),
  sampleBtn: document.getElementById('sampleBtn'),
  clearBtn: document.getElementById('clearBtn'),
  copyAiPromptBtn: document.getElementById('copyAiPromptBtn'),
  scoreStatus: document.getElementById('scoreStatus'),
  searchInput: document.getElementById('searchInput'),
  searchEngine: document.getElementById('searchEngine'),
  searchBtn: document.getElementById('searchBtn'),
  arrangeBtn: document.getElementById('arrangeBtn'),
  arrangeCards: document.getElementById('arrangeCards'),
  scorePreview: document.getElementById('scorePreview'),
  previewSummary: document.getElementById('previewSummary'),
  toastLayer: document.getElementById('toastLayer'),
};

const state = {
  instrumentId: 'piano',
  parsed: null,
  timeline: null,
  chordTrack: null,
  chordsEnabled: false,
  chordVolume: 0.42,
  bpm: 84,
  currentBeat: 0,
  octaveOffset: 0,
  metronome: false,
  loopMode: 'off', // off | all | ab
  ab: { a: null, b: null },
  playing: false,
  starting: false,
  scrubbing: false,
  resumeAfterScrub: false,
  previewActiveIndex: -1,
  readoutKey: '',
  heldCodes: new Set(),
  liveNotes: new Map(),
  modifiers: { shift: false, ctrl: false },
  theme: { ...DEFAULT_THEME },
  soundfontToastShown: false,
};

const transport = {
  timer: 0,
  segments: [],
  segmentSeed: 0,
  loop: false,
  loopStart: 0,
  loopEnd: 0,
  bps: 1.4,
  startTime: 0,
  startBeat: 0,
  cycleStartTime: 0,
  endTime: 0,
  lastBeatIndex: -1,
};

let stage = null;
let jq = null;
let progressDragging = false;

/* ------------------------------------------------------------------ utilities */

function toast(message, type = 'info', duration = 3400) {
  if (!els.toastLayer) return;
  while (els.toastLayer.children.length >= 4) {
    els.toastLayer.firstElementChild?.remove();
  }
  const node = document.createElement('div');
  node.className = `toast${type === 'info' ? '' : ` toast--${type}`}`;
  node.textContent = String(message);
  els.toastLayer.appendChild(node);
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 260);
  }, duration);
}

function setStageLoading(visible, text = '正在唤醒声音…') {
  if (!els.stageLoading) return;
  els.stageLoading.hidden = !visible;
  const label = els.stageLoading.lastElementChild;
  if (label && text) label.textContent = text;
}

function getKeyLabel(code) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

function noteNameSafe(midi) {
  return Number.isFinite(midi) ? midiToName(midi) : '—';
}

function currentKeyOffset() {
  return state.parsed?.meta?.keyOffset || 0;
}

function currentInstrument() {
  return getInstrument(state.instrumentId);
}

function totalBeats() {
  return state.timeline?.totalBeats || 0;
}

function bps() {
  return state.bpm / 60;
}

function validAB() {
  return (
    Number.isFinite(state.ab.a) &&
    Number.isFinite(state.ab.b) &&
    state.ab.b > state.ab.a
  );
}

function formatIssue(issue) {
  if (!issue) return '';
  if (issue.line > 0) {
    return `第 ${issue.line} 行第 ${issue.col} 列：${issue.message}`;
  }
  return issue.message;
}

/* ------------------------------------------------------------------ instrument UI */

function buildInstrumentButtons() {
  els.instrumentGrid.innerHTML = INSTRUMENT_ORDER.map((id) => {
    const instrument = INSTRUMENTS[id];
    return `
      <button class="instrument-btn${id === state.instrumentId ? ' is-active' : ''}" type="button" data-instrument="${instrument.id}" aria-pressed="${id === state.instrumentId}">
        <span class="instrument-btn__icon">${ICONS[instrument.id] || ''}</span>
        <span class="instrument-btn__text">
          <span class="instrument-btn__name">${escapeHtml(instrument.name)}</span>
          <span class="instrument-btn__en">${escapeHtml(instrument.en)}</span>
        </span>
        <span class="instrument-btn__bar" aria-hidden="true"></span>
      </button>`;
  }).join('');

  els.instrumentGrid.addEventListener('click', (event) => {
    const button = event.target.closest('[data-instrument]');
    if (!button) return;
    selectInstrument(button.dataset.instrument);
  });
}

function updateInstrumentUI() {
  const instrument = currentInstrument();
  for (const button of els.instrumentGrid.querySelectorAll('[data-instrument]')) {
    const active = button.dataset.instrument === instrument.id;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  els.rangeLabel.textContent = instrument.rangeLabel;
  els.rangeHint.textContent = instrument.rangeHint;
  els.stageInstrument.textContent = instrument.name;
  els.stageVisual.textContent = instrument.visual.description;
  els.stageEffectName.textContent = instrument.visual.name;
  els.soundModeLabel.textContent = audioEngine.getModeLabel();
  els.reverbPreset.value = instrument.reverb;
  const tableRows = els.instrumentTableWrap.querySelectorAll('tr[data-instrument]');
  for (const row of tableRows) {
    row.classList.toggle('is-active', row.dataset.instrument === instrument.id);
  }
  updateAudioUI();
}

function buildInstrumentTable() {
  const rows = INSTRUMENT_ORDER.map((id) => {
    const instrument = INSTRUMENTS[id];
    const genres = Object.entries(instrument.genreAffinity)
      .sort((a, b) => b[1] - a[1])
      .map(([genre]) => genre)
      .join(' / ');
    return `
      <tr data-instrument="${instrument.id}" class="${id === state.instrumentId ? 'is-active' : ''}">
        <td>${escapeHtml(instrument.name)}<br><span class="range-card__mode">${escapeHtml(instrument.en)}</span></td>
        <td>${escapeHtml(instrument.rangeLabel)}</td>
        <td>${escapeHtml(genres)}</td>
        <td>${escapeHtml(instrument.reverbLabel)}</td>
        <td>${escapeHtml(instrument.fallbackLabel)}</td>
        <td>${escapeHtml(instrument.tableKeyMap)}</td>
      </tr>`;
  }).join('');
  els.instrumentTableWrap.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th>乐器</th>
          <th>音域范围</th>
          <th>适配流派</th>
          <th>混响预设</th>
          <th>备选音色</th>
          <th>按键映射说明</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* ------------------------------------------------------------------ score library */

function loadLibrary() {
  const raw = safeStorageGet(LIBRARY_KEY, null);
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.filter((s) => s && typeof s.text === 'string') : [];
  } catch {
    return [];
  }
}

function saveLibrary(list) {
  return safeStorageSet(LIBRARY_KEY, JSON.stringify(list));
}

/** 从简谱文本猜测曲名：优先标题注释行，否则取第一小节片段。 */
function guessTitle(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(?:曲名|标题|title|name)\s*[:：]\s*(.+)$/i);
    if (match) return match[1].trim().slice(0, 40);
  }
  const firstNoteLine = lines.find((l) => /[1-7]/.test(l) && !/^[1-7]=/.test(l));
  if (firstNoteLine) {
    const snippet = firstNoteLine.replace(/[|♩\d'=]/g, '').trim();
    if (snippet) return `片段 ${snippet.slice(0, 6)}`;
  }
  return `未命名 ${new Date().toLocaleDateString('zh-CN')}`;
}

function currentSongStats() {
  if (!state.parsed) return '';
  const m = state.parsed.meta;
  return `${m.key} 调 · ${m.timeSig} · ${state.parsed.stats.bars} 小节`;
}

function renderLibrary() {
  if (!els.libraryList) return;
  const list = loadLibrary();
  els.libraryCount.textContent = String(list.length);
  if (!list.length) {
    els.libraryList.innerHTML =
      '<p class="empty-state">还没有收藏。解析一份简谱后点「存入曲库」。</p>';
    return;
  }
  const sorted = [...list].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  els.libraryList.innerHTML = sorted
    .map(
      (song) => `<div class="library-item" data-id="${escapeHtml(song.id)}">
        <div class="library-item__main">
          <span class="library-item__title" data-role="title">${escapeHtml(song.title)}</span>
          <span class="library-item__meta">${escapeHtml(song.stats || '')}</span>
        </div>
        <div class="library-item__actions">
          <button class="icon-btn" data-action="load" title="载入演奏">载入</button>
          <button class="icon-btn" data-action="rename" title="重命名">改名</button>
          <button class="icon-btn icon-btn--danger" data-action="delete" title="删除">删除</button>
        </div>
      </div>`
    )
    .join('');
}

function addToLibrary() {
  const text = els.scoreInput.value.trim();
  if (!text) {
    toast('简谱输入框是空的，没有可存的内容。', 'warn', 2600);
    return;
  }
  if (!state.parsed) {
    toast('请先点击「解析并载入」，成功后再存入曲库。', 'warn', 2800);
    return;
  }
  const list = loadLibrary();
  const title = (els.songTitleInput.value || '').trim() || guessTitle(text);
  const now = Date.now();
  list.push({
    id: nextId('song'),
    title,
    text,
    stats: currentSongStats(),
    createdAt: now,
    updatedAt: now,
  });
  if (!saveLibrary(list)) {
    toast('保存失败：浏览器存储不可用或空间已满。', 'error', 3600);
    return;
  }
  els.songTitleInput.value = '';
  renderLibrary();
  toast(`已存入曲库：${title}`, 'ok', 2400);
}

function handleLibraryClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const item = button.closest('.library-item');
  if (!item) return;
  const id = item.dataset.id;
  const action = button.dataset.action;
  let list = loadLibrary();
  const index = list.findIndex((s) => s.id === id);
  if (index < 0) return;

  if (action === 'load') {
    const song = list[index];
    els.scoreInput.value = song.text;
    els.songTitleInput.value = song.title;
    loadScore(song.text);
    toast(`已载入：${song.title}`, 'ok', 2200);
  } else if (action === 'rename') {
    const titleEl = item.querySelector('[data-role="title"]');
    const current = titleEl.textContent;
    const next = window.prompt('输入新的曲名：', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      toast('曲名不能为空。', 'warn', 2200);
      return;
    }
    list[index].title = trimmed;
    list[index].updatedAt = Date.now();
    if (!saveLibrary(list)) {
      toast('保存失败：浏览器存储不可用。', 'error', 3000);
      return;
    }
    renderLibrary();
  } else if (action === 'delete') {
    const confirmed = window.confirm(`确定删除「${list[index].title}」吗？此操作不可撤销。`);
    if (!confirmed) return;
    list.splice(index, 1);
    saveLibrary(list);
    renderLibrary();
    toast('已从曲库删除。', 'info', 2000);
  }
}

/* ------------------------------------------------------------------ keyboard hints */

function keycap(code, note, mod = 'base', extraClass = '') {
  return `<button class="keycap ${extraClass}" type="button" data-code="${code}" data-mod="${mod}" title="${escapeHtml(getKeyLabel(code))} · ${escapeHtml(note)}（可点击发声）">
    <span class="keycap__note">${escapeHtml(note)}</span>
    <span class="keycap__key">${escapeHtml(getKeyLabel(code))}</span>
  </button>`;
}

function staticKeycap(label, note) {
  return `<span class="keycap keycap--static" title="${escapeHtml(label)} · ${escapeHtml(note)}">
    <span class="keycap__note">${escapeHtml(note)}</span>
    <span class="keycap__key">${escapeHtml(label)}</span>
  </span>`;
}

function emptyKeycap(code) {
  return `<span class="keycap keycap--empty" aria-hidden="true"><span class="keycap__key">${escapeHtml(getKeyLabel(code))}</span></span>`;
}

const PHYSICAL_ROWS = [
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM'],
];

/** 返回某物理键在当前乐器下的简谱显示，未映射返回 null。 */
function noteLabelForCode(code, instrument) {
  if (instrument.id === 'piano') {
    if (PIANO_MAIN[code]) return { note: String(PIANO_MAIN[code]), mod: 'base' };
    if (PIANO_SHARP[code]) return { note: `#${PIANO_SHARP[code]}`, mod: 'base' };
    return null;
  }
  if (instrument.id === 'guitar') {
    for (const row of GUITAR_ROWS) {
      const idx = row.keys.indexOf(code);
      if (idx >= 0) return { note: String(idx + 1), mod: row.mod };
    }
    return null;
  }
  if (LETTER_DEGREES[code]) return { note: String(LETTER_DEGREES[code]), mod: 'base' };
  return null;
}

function buildKeyboardStrip() {
  const instrument = currentInstrument();
  const rowNames = ['上排', '中排', '下排'];
  let html = '<div class="vkbd">';

  PHYSICAL_ROWS.forEach((codes, rowIndex) => {
    html += `<div class="vkbd__row"><span class="vkbd__tag">${rowNames[rowIndex]}</span><div class="vkbd__keys">`;
    for (const code of codes) {
      const info = noteLabelForCode(code, instrument);
      html += info ? keycap(code, info.note, info.mod) : emptyKeycap(code);
    }
    html += '</div></div>';
  });

  html += '</div>';

  const modifierLabel = instrument.id === 'piano' ? '八度' : instrument.id === 'violin' ? '高把位' : instrument.id === 'guitar' ? '高把位' : '超吹';
  const halfLabel = instrument.id === 'guitar' ? '高弦' : '半音';
  html += `<div class="vkbd__mods">
    ${staticKeycap('Shift', modifierLabel)}${staticKeycap('Ctrl', halfLabel)}
    <span class="vkbd__hint">上方数字=简谱音 · 按钮字母=键盘按键 · 可直接点击</span>
  </div>`;

  els.keyboardStrip.innerHTML = html;
}

function setHeldKey(code, held, mod = 'base') {
  if (!els.keyboardStrip) return;
  const caps = els.keyboardStrip.querySelectorAll(`[data-code="${code}"]`);
  for (const cap of caps) {
    if ((cap.dataset.mod || 'base') === mod) {
      cap.classList.toggle('is-held', held);
    }
  }
}

function clearHeldKey(code) {
  if (!els.keyboardStrip) return;
  const caps = els.keyboardStrip.querySelectorAll(`[data-code="${code}"]`);
  for (const cap of caps) cap.classList.remove('is-held');
}

/* ------------------------------------------------------------------ audio UI */

function updateAudioUI() {
  const status = audioEngine.getStatus();
  const loading = audioEngine.loading.has(audioEngine.instrumentId);
  let mode = 'locked';
  let text = '音频待唤醒';

  if (status.unlocked) {
    if (loading) {
      mode = 'loading';
      text = '音色加载中…';
    } else if (status.soundfontFailed) {
      mode = 'fallback';
      text = '内置合成音色';
    } else if (status.mode === 'soundfont') {
      mode = 'running';
      text = status.label;
    } else {
      mode = 'running';
      text = '音频已就绪';
    }
  }

  els.audioStatus.dataset.state = mode;
  els.audioStatusText.textContent = text;
  els.audioWakeBtn.hidden = status.unlocked;
  els.retrySoundfontBtn.hidden = !status.soundfontFailed;
  els.soundModeLabel.textContent = status.label;
  els.audioStatus.title = `${status.label} · ${status.unlocked ? '音频已启动' : '点击页面唤醒音频'}`;
}

async function primeAudio() {
  if (audioEngine.isUnlocked) return;
  try {
    await audioEngine.unlock();
    stage?.resetClock();
    updateAudioUI();
  } catch {
    /* 首次手势之外的失败留给正式播放时提示 */
  }
}

async function ensureAudio({ load = true } = {}) {
  if (audioEngine.isUnlocked) {
    if (load) audioEngine.loadCurrentInstrument();
    updateAudioUI();
    return true;
  }
  setStageLoading(true, '正在唤醒声音…');
  try {
    await audioEngine.unlock();
    stage?.resetClock();
    updateAudioUI();
    setStageLoading(false);
    if (load) audioEngine.loadCurrentInstrument();
    return true;
  } catch (error) {
    setStageLoading(false);
    updateAudioUI();
    toast(error?.message || '音频启动失败，请刷新页面后重试。', 'error', 4600);
    return false;
  }
}

audioEngine.on('unlock', () => {
  updateAudioUI();
  setStageLoading(false);
});

audioEngine.on('soundfontloading', ({ name }) => {
  updateAudioUI();
  els.soundModeLabel.textContent = `加载 ${name} 采样音色…`;
});

audioEngine.on('soundfontready', ({ name, label }) => {
  updateAudioUI();
  toast(`采样音色已就绪：${name} · ${label}`, 'ok', 2600);
});

audioEngine.on('fallback', ({ message }) => {
  updateAudioUI();
  if (!state.soundfontToastShown) {
    state.soundfontToastShown = true;
    toast(message, 'warn', 5200);
  }
});

audioEngine.on('statechange', () => updateAudioUI());

/* ------------------------------------------------------------------ instrument selection */

function selectInstrument(id, { silent = false } = {}) {
  const instrument = getInstrument(id);
  if (!INSTRUMENTS[id]) return;
  if (state.instrumentId === instrument.id) {
    if (!silent) toast(`当前已经是${instrument.name}。`, 'info', 1800);
    return;
  }

  const wasPlaying = state.playing;
  const now = audioEngine.clock();
  const beat = wasPlaying ? visualBeatAt(now) : state.currentBeat;
  if (wasPlaying) stopTransport({ resetBeat: false, keepPosition: false, keepBeat: beat });
  stopAllLiveNotes();
  state.soundfontToastShown = false;

  state.instrumentId = instrument.id;
  audioEngine.setInstrument(instrument.id);
  stage?.setInstrument(instrument.id);
  updateInstrumentUI();
  buildKeyboardStrip();
  renderPreview();
  if (wasPlaying && state.parsed) {
    beginTransport(beat);
  } else {
    state.currentBeat = clamp(beat, 0, totalBeats());
    updatePositionUI(state.currentBeat);
  }

  if (audioEngine.isUnlocked) {
    audioEngine.loadCurrentInstrument();
  }
  if (!silent) toast(`已切换到${instrument.name}。`, 'info', 1800);
}

/* ------------------------------------------------------------------ theme */

function loadTheme() {
  const raw = safeStorageGet(THEME_KEY, '');
  if (!raw) return { ...DEFAULT_THEME };
  try {
    const parsed = JSON.parse(raw);
    const color = hexToRgb(parsed.color) ? rgbToHex(...Object.values(hexToRgb(parsed.color))) : DEFAULT_THEME.color;
    return {
      color,
      brightness: clamp(Number(parsed.brightness) || 1, 0.3, 1.8),
      density: clamp(Number(parsed.density) || 1, 0.3, 2),
    };
  } catch {
    return { ...DEFAULT_THEME };
  }
}

const persistTheme = debounce(() => {
  safeStorageSet(THEME_KEY, JSON.stringify(state.theme));
}, 220);

function applyThemeToUI() {
  const rgb = hexToRgb(state.theme.color) || { r: 169, g: 196, b: 238 };
  els.themeColor.value = state.theme.color;
  els.hexInput.value = state.theme.color;
  els.rgbInput.value = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  els.colorSwatch.style.background = state.theme.color;
  els.particleBrightness.value = String(Math.round(state.theme.brightness * 100));
  els.particleDensity.value = String(Math.round(state.theme.density * 100));
  els.brightnessValue.textContent = `${Math.round(state.theme.brightness * 100)}%`;
  els.densityValue.textContent = `${Math.round(state.theme.density * 100)}%`;
  stage?.setTheme(state.theme);
  persistTheme();
}

function applyColor(hex, { syncHex = true, syncRgb = true, from = 'color' } = {}) {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const normalized = rgbToHex(rgb.r, rgb.g, rgb.b);
  state.theme.color = normalized;
  if (from !== 'color') els.themeColor.value = normalized;
  if (from !== 'hex' && syncHex) els.hexInput.value = normalized;
  if (from !== 'rgb' && syncRgb) els.rgbInput.value = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  els.colorSwatch.style.background = normalized;
  stage?.setTheme(state.theme);
  persistTheme();
  return true;
}

function applyBrightness(value) {
  state.theme.brightness = clamp(value / 100, 0.3, 1.8);
  els.brightnessValue.textContent = `${Math.round(value)}%`;
  stage?.setTheme(state.theme);
  persistTheme();
}

function applyDensity(value) {
  state.theme.density = clamp(value / 100, 0.3, 2);
  els.densityValue.textContent = `${Math.round(value)}%`;
  stage?.setTheme(state.theme);
  persistTheme();
}

function bindThemePanelWhenReady() {
  if (window.jQuery) {
    bindThemePanel();
    return;
  }
  let settled = false;
  const run = () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    bindThemePanel();
  };
  const timer = window.setTimeout(run, 1800);
  const script = document.getElementById('jqueryCdn');
  if (!script) {
    run();
    return;
  }
  script.addEventListener('load', run, { once: true });
  script.addEventListener('error', run, { once: true });
}

function bindThemePanel() {
  jq = window.jQuery || null;
  const bind = (selector, event, handler) => {
    const node = document.querySelector(selector);
    if (!node) return;
    if (jq) jq(selector).on(event, handler);
    else node.addEventListener(event, handler);
  };

  bind('#particleBrightness', 'input', (event) => {
    const value = Number(event.target.value);
    applyBrightness(value);
  });

  bind('#particleDensity', 'input', (event) => {
    const value = Number(event.target.value);
    applyDensity(value);
  });

  bind('#themeColor', 'input', (event) => {
    applyColor(event.target.value, { from: 'color' });
  });

  bind('#hexInput', 'input', (event) => {
    const value = event.target.value.trim();
    const ok = applyColor(value, { from: 'hex', syncHex: false });
    event.target.classList.toggle('is-invalid', !ok && value.length > 0);
  });

  bind('#hexInput', 'change', (event) => {
    const ok = applyColor(event.target.value.trim(), { from: 'hex' });
    event.target.classList.toggle('is-invalid', !ok);
    if (ok) event.target.value = state.theme.color;
  });

  bind('#rgbInput', 'input', (event) => {
    const rgb = parseRgbString(event.target.value);
    const ok = rgb ? applyColor(rgbToHex(rgb.r, rgb.g, rgb.b), { from: 'rgb', syncRgb: false }) : false;
    event.target.classList.toggle('is-invalid', !ok && event.target.value.trim().length > 0);
  });

  bind('#rgbInput', 'change', (event) => {
    const rgb = parseRgbString(event.target.value);
    const ok = rgb ? applyColor(rgbToHex(rgb.r, rgb.g, rgb.b), { from: 'rgb' }) : false;
    event.target.classList.toggle('is-invalid', !ok);
    if (ok) {
      const finalRgb = hexToRgb(state.theme.color);
      event.target.value = `${finalRgb.r}, ${finalRgb.g}, ${finalRgb.b}`;
    }
  });

  bind('#copyColorBtn', 'click', async () => {
    const rgb = hexToRgb(state.theme.color);
    const text = `${state.theme.color.toUpperCase()} · RGB(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    const ok = await copyText(text);
    toast(ok ? `已复制色值：${text}` : '复制失败，请检查浏览器剪贴板权限。', ok ? 'ok' : 'warn', 2400);
  });

  bind('#resetThemeBtn', 'click', () => {
    state.theme = { ...DEFAULT_THEME };
    applyThemeToUI();
    toast('已恢复默认粒子色与亮度。', 'ok', 2000);
  });

  if (els.themeJqStatus) {
    els.themeJqStatus.textContent = jq
      ? '调色面板由 jQuery CDN 驱动；演奏与渲染核心不依赖 jQuery。'
      : 'jQuery CDN 未加载，已自动改用原生事件；调色功能不受影响。';
  }
}

/* ------------------------------------------------------------------ score load & preview */

function renderScoreStatus({ type, title, meta, issues = [] }) {
  const icon = type === 'ok' ? '✓' : type === 'warn' ? '!' : type === 'error' ? '×' : '·';
  const list = issues
    .slice(0, 6)
    .map((issue) => `<li>${escapeHtml(formatIssue(issue))}</li>`)
    .join('');
  const more = issues.length > 6 ? `<li>另有 ${issues.length - 6} 条提示…</li>` : '';
  els.scoreStatus.className = `score-status${type === 'ok' ? ' score-status--ok' : type === 'warn' ? ' score-status--warn' : type === 'error' ? ' score-status--error' : ''}`;
  els.scoreStatus.innerHTML = `
    <span class="score-status__icon" aria-hidden="true">${icon}</span>
    <span class="score-status__body">
      <strong>${escapeHtml(title)}</strong>
      ${meta ? `<span class="score-status__meta">${escapeHtml(meta)}</span>` : ''}
      ${list ? `<ul class="score-status__list">${list}${more}</ul>` : ''}
    </span>`;
}

function updateScoreChips() {
  const meta = state.parsed?.meta;
  els.keyChip.textContent = meta ? `1=${meta.key}` : '1=C';
  els.meterChip.textContent = meta ? meta.timeSig : '4/4';
  els.bpmChip.textContent = `♩=${Math.round(state.bpm)}`;
  if (els.tempoRange.value !== String(Math.round(state.bpm))) {
    els.tempoRange.value = String(Math.round(state.bpm));
  }
  els.tempoValue.textContent = String(Math.round(state.bpm));
}

function updateTotalTime() {
  const seconds = totalBeats() / bps();
  els.totalTime.textContent = formatClock(seconds);
}

function loadScore(text, { announce = true } = {}) {
  const result = parseScore(text);
  if (!result.ok) {
    const issues = result.errors || [];
    renderScoreStatus({
      type: 'error',
      title: '解析失败，请检查写入格式',
      meta: state.parsed ? '当前仍保留上一份可播放的乐谱。' : '还没有可播放的乐谱。',
      issues,
    });
    toast(issues[0] ? issues[0].message : '简谱解析失败。', 'error', 4600);
    return false;
  }

  stopTransport({ resetBeat: true });
  stopAllLiveNotes();
  state.parsed = result;
  state.timeline = buildTimeline(result.notes);
  state.chordTrack = buildChordTrack(result, state.timeline);
  if (els.chordInfo && state.chordsEnabled && state.chordTrack?.events?.length) {
    els.chordInfo.textContent = `已为 ${state.chordTrack.barCount} 小节生成和弦：${state.chordTrack.chords.slice(0, 8).join(' · ')}${state.chordTrack.chords.length > 8 ? ' …' : ''}`;
  }
  state.currentBeat = 0;
  state.bpm = clamp(Number(result.meta.bpm) || 80, 20, 300);
  state.ab = { a: null, b: null };
  state.loopMode = 'off';
  state.metronome = false;
  state.previewActiveIndex = -1;

  stage?.setScoreMeta({
    keyOffset: result.meta.keyOffset,
    timeSigNum: result.meta.timeSigNum,
    timeSigDen: result.meta.timeSigDen,
    totalBeats: state.timeline.totalBeats,
  });
  stage?.setTransport({
    beat: 0,
    playing: false,
    totalBeats: state.timeline.totalBeats,
    barLength: result.meta.timeSigNum,
    ab: state.ab,
    loopMode: state.loopMode,
    metronome: false,
  });

  updateScoreChips();
  updateTotalTime();
  updateMetronomeUI();
  updateLoopUI();
  updateABUI();
  updatePositionUI(0);
  renderPreview();

  const warnings = result.warnings || [];
  renderScoreStatus({
    type: warnings.length ? 'warn' : 'ok',
    title: warnings.length ? `已载入，有 ${warnings.length} 条提示` : '乐谱已载入',
    meta: `${result.meta.key} 调 · ${result.meta.timeSig} · ${result.meta.bpm} BPM · ${result.stats.bars} 小节 · ${result.stats.noteCount} 个音`,
    issues: warnings,
  });

  if (announce) {
    toast(
      warnings.length
        ? `已载入 ${result.stats.noteCount} 个音，${warnings.length} 条格式提示。`
        : `已载入 ${result.stats.noteCount} 个音，${result.stats.bars} 小节。`,
      warnings.length ? 'warn' : 'ok',
      2600
    );
  }
  return true;
}

function clearScore() {
  stopTransport({ resetBeat: true });
  stopAllLiveNotes();
  state.parsed = null;
  state.timeline = null;
  state.chordTrack = null;
  state.currentBeat = 0;
  state.ab = { a: null, b: null };
  state.loopMode = 'off';
  state.metronome = false;
  state.previewActiveIndex = -1;
  els.scoreInput.value = '';
  els.keyChip.textContent = '1=C';
  els.meterChip.textContent = '4/4';
  els.bpmChip.textContent = `♩=${Math.round(state.bpm)}`;
  els.totalTime.textContent = '0:00';
  els.progressRange.max = '1';
  els.progressRange.value = '0';
  els.progressFill.style.width = '0%';
  els.scorePreview.innerHTML = '<p class="empty-state">解析后的音符会按小节排在这里。</p>';
  els.previewSummary.textContent = '尚未载入';
  els.arrangeCards.innerHTML =
    '<p class="empty-state">载入乐谱后，会给出流派、主奏、伴奏、混响与速度建议。所有推荐都可以手动覆盖。</p>';
  stage?.setScoreMeta({ keyOffset: 0, timeSigNum: 4, timeSigDen: 4, totalBeats: 0 });
  stage?.setTransport({
    beat: 0,
    playing: false,
    totalBeats: 0,
    barLength: 4,
    ab: { a: null, b: null },
    loopMode: 'off',
    metronome: false,
  });
  updateLoopUI();
  updateABUI();
  updateMetronomeUI();
  updatePositionUI(0);
  renderScoreStatus({
    type: '',
    title: '简谱已清空',
    meta: '粘贴简谱文本后点击「解析并载入」。',
    issues: [],
  });
}

function renderPreview() {
  if (!state.parsed) {
    els.scorePreview.innerHTML = '<p class="empty-state">解析后的音符会按小节排在这里。</p>';
    els.previewSummary.textContent = '尚未载入';
    return;
  }

  const instrument = currentInstrument();
  const notes = state.parsed.notes;
  const byBar = new Map();
  for (const [index, note] of notes.entries()) {
    if (!byBar.has(note.barIndex)) byBar.set(note.barIndex, []);
    byBar.get(note.barIndex).push({ note, index });
  }
  const maxBar = notes.length ? Math.max(...notes.map((note) => note.barIndex)) : 0;
  const chunks = [];
  let rendered = 0;
  let truncated = false;

  for (let bar = 0; bar <= maxBar; bar += 1) {
    const entries = byBar.get(bar) || [];
    const chips = [];
    for (const { note, index } of entries) {
      if (rendered >= MAX_PREVIEW_NOTES) {
        truncated = true;
        break;
      }
      rendered += 1;
      let classes = 'note-chip';
      let title = `${formatNoteToken(note)} · ${note.duration} 拍`;
      if (note.scale === 0) {
        classes += ' is-rest';
        title = `休止 ${note.duration} 拍`;
      } else {
        const midi = noteToMidi(note, state.parsed.meta.keyOffset);
        const fit = fitMidiToRange(midi, instrument.minMidi, instrument.maxMidi);
        if (fit.adjusted) {
          classes += ' is-out-of-range';
          title += ` · ${noteNameSafe(midi)} → ${noteNameSafe(fit.midi)}（自动移八度）`;
        } else if (fit.midi === null) {
          classes += ' is-out-of-range';
          title += ' · 超出音域';
        } else {
          title += ` · ${noteNameSafe(midi)}`;
        }
      }
      chips.push(`<span class="${classes}" data-index="${index}" title="${escapeHtml(title)}">
        <span class="note-chip__jp">${escapeHtml(formatNoteToken(note))}</span>
        <span class="note-chip__dur">${formatDurationLabel(note.duration)}</span>
      </span>`);
    }
    chunks.push(`<div class="score-bar"><span class="bar-index">${bar + 1}</span>${chips.join('')}</div>`);
    if (truncated) break;
  }

  if (truncated) {
    chunks.push('<p class="empty-state">乐谱较长，预览只显示前 420 个音符；播放不受影响。</p>');
  }

  els.scorePreview.innerHTML = chunks.join('');
  els.previewSummary.textContent = `${state.parsed.stats.bars} 小节 · ${state.parsed.stats.noteCount} 音`;
  state.previewActiveIndex = -1;
}

function formatDurationLabel(duration) {
  if (Math.abs(duration - 0.5) < 1e-9) return '½';
  if (Math.abs(duration - 0.25) < 1e-9) return '¼';
  if (Number.isInteger(duration)) return `${duration}`;
  return duration.toFixed(1);
}

function updatePreviewHighlight(beat) {
  let activeIndex = -1;
  if (state.playing && state.timeline) {
    for (const event of state.timeline.events) {
      if (beat >= event.startBeat && beat < event.startBeat + event.durationBeats) {
        activeIndex = event.index;
        break;
      }
    }
  }
  if (activeIndex === state.previewActiveIndex) return;
  if (state.previewActiveIndex >= 0) {
    const previous = els.scorePreview.querySelector(`.note-chip[data-index="${state.previewActiveIndex}"]`);
    previous?.classList.remove('is-playing');
  }
  if (activeIndex >= 0) {
    const current = els.scorePreview.querySelector(`.note-chip[data-index="${activeIndex}"]`);
    current?.classList.add('is-playing');
  }
  state.previewActiveIndex = activeIndex;
}

/* ------------------------------------------------------------------ arrangement */

function renderArrangement(result) {
  if (!result) {
    els.arrangeCards.innerHTML = '<p class="empty-state">没有足够的信息生成编配建议。</p>';
    return;
  }

  const leadConfidence = Math.round(result.lead.confidence * 100);
  const genreConfidence = Math.round(result.genreConfidence * 100);
  const stats = result.stats;

  els.arrangeCards.innerHTML = `
    <article class="arrange-card arrange-card--genre">
      <div class="arrange-card__head">
        <span class="arrange-card__title">流派判定 · ${escapeHtml(result.genre)}</span>
        <span class="arrange-card__tag">${genreConfidence}% 匹配</span>
      </div>
      <p class="arrange-card__reason">${escapeHtml(result.genreReason)}</p>
      <div class="arrange-metrics">
        <span class="metric"><strong>${stats.span}</strong>半音跨度</span>
        <span class="metric"><strong>${stats.density}</strong>音 / 拍</span>
        <span class="metric"><strong>${stats.bpm}</strong>BPM</span>
        <span class="metric"><strong>${stats.pentatonicPercent}%</strong>五声</span>
      </div>
    </article>

    <article class="arrange-card">
      <div class="arrange-card__head">
        <span class="arrange-card__title">主奏 · ${escapeHtml(result.lead.name)}</span>
        <span class="arrange-card__tag">${leadConfidence}% 契合</span>
      </div>
      <p class="arrange-card__reason">${escapeHtml(result.lead.reason)}</p>
      <div class="arrange-actions">
        <button class="ghost-btn ghost-btn--small" type="button" data-arrange-action="lead" data-id="${result.lead.id}">应用主奏</button>
      </div>
    </article>

    <article class="arrange-card">
      <div class="arrange-card__head">
        <span class="arrange-card__title">伴奏 · ${escapeHtml(result.accompaniment.name)}</span>
        <span class="arrange-card__tag">音色区分</span>
      </div>
      <p class="arrange-card__reason">${escapeHtml(result.accompaniment.reason)}</p>
      <div class="arrange-actions">
        <button class="ghost-btn ghost-btn--small" type="button" data-arrange-action="accompaniment" data-id="${result.accompaniment.id}">试听伴奏音色</button>
      </div>
    </article>

    <article class="arrange-card">
      <div class="arrange-card__head">
        <span class="arrange-card__title">混响 · ${escapeHtml(result.reverb.label)}</span>
        <span class="arrange-card__tag">空间感</span>
      </div>
      <p class="arrange-card__reason">${escapeHtml(result.reverb.reason)}</p>
      <div class="arrange-actions">
        <button class="ghost-btn ghost-btn--small" type="button" data-arrange-action="reverb" data-preset="${result.reverb.preset}">应用混响</button>
      </div>
    </article>

    <article class="arrange-card">
      <div class="arrange-card__head">
        <span class="arrange-card__title">速度 · ${result.tempo.bpm} BPM</span>
        <span class="arrange-card__tag">小幅适配</span>
      </div>
      <p class="arrange-card__reason">${escapeHtml(result.tempo.reason)}</p>
      <div class="arrange-actions">
        <button class="ghost-btn ghost-btn--small" type="button" data-arrange-action="tempo" data-bpm="${result.tempo.bpm}">应用速度</button>
      </div>
    </article>

    <p class="arrange-note">${escapeHtml(result.note)}</p>`;
}

function handleArrangementClick(event) {
  const button = event.target.closest('[data-arrange-action]');
  if (!button) return;
  const action = button.dataset.arrangeAction;
  if (action === 'lead' || action === 'accompaniment') {
    selectInstrument(button.dataset.id);
  } else if (action === 'reverb') {
    const preset = button.dataset.preset === 'short' ? 'short' : 'long';
    audioEngine.setReverbPreset(preset);
    els.reverbPreset.value = preset;
    toast(`已应用${preset === 'short' ? '短' : '长'}混响建议。`, 'ok', 2200);
  } else if (action === 'tempo') {
    setTempo(Number(button.dataset.bpm), { applyNow: true });
    toast(`速度已调整为 ${button.dataset.bpm} BPM。`, 'ok', 2200);
  }
}

/* ------------------------------------------------------------------ transport */

function makeSegment(startBeat, endBeat, startTime) {
  const events = state.timeline?.events || [];
  let pointer = 0;
  while (
    pointer < events.length &&
    events[pointer].startBeat + events[pointer].durationBeats <= startBeat
  ) {
    pointer += 1;
  }
  const chordEvents = state.chordTrack?.events || [];
  let chordPointer = 0;
  while (
    chordPointer < chordEvents.length &&
    chordEvents[chordPointer].startBeat + chordEvents[chordPointer].durationBeats <= startBeat
  ) {
    chordPointer += 1;
  }
  return {
    id: ++transport.segmentSeed,
    startBeat,
    endBeat,
    startTime,
    pointer,
    chordPointer,
    nextClickBeat: Math.ceil(startBeat - 1e-9),
  };
}

function loopRange() {
  const total = totalBeats();
  if (state.loopMode === 'ab' && validAB()) {
    return { start: state.ab.a, end: state.ab.b, loop: true };
  }
  if (state.loopMode === 'all') {
    return { start: 0, end: total, loop: true };
  }
  return { start: 0, end: total, loop: false };
}

function beginTransport(fromBeat) {
  if (!state.parsed) {
    toast('先解析一份简谱，再开始播放。', 'warn', 2400);
    return false;
  }
  if (!audioEngine.isUnlocked) {
    return false;
  }
  stopTransport({ resetBeat: false, keepPosition: false });
  const total = totalBeats();
  if (total <= 0) {
    toast('当前乐谱没有可播放的时长。', 'warn', 2600);
    return false;
  }
  const range = loopRange();
  let beat = Number.isFinite(fromBeat) ? clamp(fromBeat, 0, total) : 0;
  if (!range.loop && beat >= total) beat = 0;
  if (range.loop && (beat < range.start || beat >= range.end)) beat = range.start;
  if (!range.loop && (beat < 0 || beat > total)) beat = 0;

  transport.loop = range.loop;
  transport.loopStart = range.start;
  transport.loopEnd = range.end;
  transport.bps = bps();
  transport.startBeat = beat;
  transport.startTime = audioEngine.clock() + PRE_ROLL_SECONDS;
  transport.cycleStartTime = transport.startTime - (beat - range.start) / transport.bps;
  transport.endTime = transport.startTime + (range.end - beat) / transport.bps;
  transport.segmentSeed = 0;
  transport.segments = [makeSegment(beat, range.end, transport.startTime)];
  transport.lastBeatIndex = Math.floor(beat);

  state.playing = true;
  state.currentBeat = beat;
  stage?.clearTimeline();
  stage?.setTransport({
    beat,
    playing: true,
    totalBeats: total,
    barLength: state.parsed.meta.timeSigNum,
    ab: state.ab,
    loopMode: state.loopMode,
    metronome: state.metronome,
  });

  schedulerTick();
  transport.timer = window.setInterval(schedulerTick, SCHEDULER_INTERVAL_MS);
  updatePlayUI();
  updatePositionUI(beat);
  updateMetronomeUI();
  els.stageHint?.classList.add('is-hidden');
  return true;
}

async function startPlayback() {
  if (state.playing) {
    pausePlayback();
    return;
  }
  if (!state.parsed) {
    toast('先在右侧粘贴或载入一份简谱。', 'warn', 2600);
    els.scoreInput?.focus();
    return;
  }
  if (state.starting) return;
  state.starting = true;
  try {
    const ok = await ensureAudio({ load: true });
    if (!ok) return;
    let beat = state.currentBeat;
    if (beat >= totalBeats()) beat = 0;
    beginTransport(beat);
  } finally {
    state.starting = false;
  }
}

function pausePlayback({ reset = false, silent = false } = {}) {
  if (!state.playing) {
    if (reset) {
      state.currentBeat = 0;
      updatePositionUI(0);
    }
    return;
  }
  const now = audioEngine.clock();
  const beat = visualBeatAt(now);
  stopTransport({ resetBeat: reset, keepPosition: false, keepBeat: beat });
  if (!silent) updatePlayUI();
}

function stopTransport({ resetBeat = false, keepBeat = null } = {}) {
  if (transport.timer) {
    window.clearInterval(transport.timer);
    transport.timer = 0;
  }
  transport.segments = [];
  const wasPlaying = state.playing;
  state.playing = false;
  audioEngine.stopAll({ immediate: true });
  stage?.clearTimeline();
  stage?.allNotesOff();
  if (resetBeat) {
    state.currentBeat = 0;
  } else if (Number.isFinite(keepBeat)) {
    state.currentBeat = clamp(keepBeat, 0, totalBeats());
  } else {
    state.currentBeat = clamp(state.currentBeat, 0, totalBeats());
  }
  transport.lastBeatIndex = -1;
  updatePlayUI();
  updatePositionUI(state.currentBeat);
  if (wasPlaying) {
    stage?.setTransport({ playing: false, beat: state.currentBeat });
  }
}

function visualBeatAt(now) {
  if (!state.playing) return state.currentBeat;
  const { loop, loopStart, loopEnd, bps: b, cycleStartTime, startTime, startBeat } = transport;
  if (now < startTime) return startBeat;
  if (!loop) {
    return clamp(loopStart + (now - cycleStartTime) * b, loopStart, loopEnd);
  }
  const length = loopEnd - loopStart;
  if (length <= 0) return loopStart;
  const elapsed = now - cycleStartTime;
  const position = (((elapsed * b) % length) + length) % length;
  return loopStart + position;
}

function segmentEndTime(segment) {
  return segment.startTime + (segment.endBeat - segment.startBeat) / transport.bps;
}

function ensureSegments(horizon) {
  if (!transport.segments.length) return;
  let guard = 0;
  while (guard < 8) {
    const last = transport.segments[transport.segments.length - 1];
    if (segmentEndTime(last) >= horizon) break;
    if (!transport.loop) break;
    transport.segments.push(
      makeSegment(transport.loopStart, transport.loopEnd, segmentEndTime(last))
    );
    guard += 1;
  }
  // 清掉已经很旧的段落，避免长时间播放累积。
  const now = audioEngine.clock();
  if (transport.segments.length > 2) {
    transport.segments = transport.segments.filter(
      (segment, index) => index === transport.segments.length - 1 || segmentEndTime(segment) >= now - 1.5
    );
  }
}

function scheduleSegment(segment, horizon) {
  if (!state.parsed || !state.timeline) return;
  const events = state.timeline.events;
  const instrument = currentInstrument();
  const keyOffset = state.parsed.meta.keyOffset;
  const barLength = Math.max(1, state.parsed.meta.timeSigNum);

  while (segment.pointer < events.length) {
    const event = events[segment.pointer];
    if (event.startBeat >= segment.endBeat) break;
    const eventEnd = event.startBeat + event.durationBeats;
    if (eventEnd <= segment.startBeat) {
      segment.pointer += 1;
      continue;
    }
    const effectiveStart = Math.max(event.startBeat, segment.startBeat);
    const when = segment.startTime + (effectiveStart - segment.startBeat) / transport.bps;
    if (when > horizon) break;
    const durationBeats = Math.min(segment.endBeat, eventEnd) - effectiveStart;
    if (durationBeats <= 0) {
      segment.pointer += 1;
      continue;
    }
    const midi = noteToMidi(event.note, keyOffset);
    if (midi !== null) {
      const voice = audioEngine.playNote(midi, {
        when,
        duration: durationBeats / transport.bps,
        source: 'score',
        velocity: 0.78,
        fit: true,
      });
      if (voice && !voice.muted) {
        stage?.scheduleNote({
          id: `score-${segment.id}-${event.index}`,
          when,
          midi: voice.midi,
          duration: durationBeats / transport.bps,
          velocity: 0.78,
          adjusted: voice.adjusted,
        });
      }
    }
    segment.pointer += 1;
  }

  if (state.chordsEnabled && state.chordTrack?.events?.length) {
    const chordEvents = state.chordTrack.events;
    while (segment.chordPointer < chordEvents.length) {
      const chord = chordEvents[segment.chordPointer];
      if (chord.startBeat >= segment.endBeat) break;
      const chordEnd = chord.startBeat + chord.durationBeats;
      if (chordEnd <= segment.startBeat) {
        segment.chordPointer += 1;
        continue;
      }
      const effStart = Math.max(chord.startBeat, segment.startBeat);
      const when = segment.startTime + (effStart - segment.startBeat) / transport.bps;
      if (when > horizon) break;
      const durBeats = Math.min(segment.endBeat, chordEnd) - effStart;
      if (durBeats > 0) {
        const seconds = durBeats / transport.bps;
        const velocity = state.chordVolume;
        audioEngine.playChordTone(chord.bassMidi, {
          when,
          duration: Math.min(seconds, transport.bps * 1.6),
          velocity: velocity * 0.9,
          bass: true,
        });
        chord.chordMidis.forEach((midi, idx) => {
          audioEngine.playChordTone(midi, {
            when: when + idx * 0.012,
            duration: seconds,
            velocity: velocity * 0.55,
          });
        });
      }
      segment.chordPointer += 1;
    }
  }

  while (segment.nextClickBeat < segment.endBeat) {
    const when =
      segment.startTime + (segment.nextClickBeat - segment.startBeat) / transport.bps;
    if (when > horizon) break;
    if (state.metronome && when >= audioEngine.clock() - 0.05) {
      const accent = Math.abs(segment.nextClickBeat % barLength) < 1e-9;
      audioEngine.click(when, accent);
    }
    segment.nextClickBeat += 1;
  }
}

function schedulerTick() {
  if (!state.playing) return;
  try {
    const now = audioEngine.clock();
    const horizon = now + LOOKAHEAD_SECONDS;
    ensureSegments(horizon);
    for (const segment of [...transport.segments]) {
      scheduleSegment(segment, horizon);
    }
    if (!transport.loop && now >= transport.endTime + 0.32) {
      finishPlayback();
    }
  } catch (error) {
    console.error('[FloatNote] scheduler failed:', error);
    pausePlayback();
    toast('播放调度出现异常，已暂停。请刷新页面后重试。', 'error', 4600);
  }
}

function finishPlayback() {
  if (transport.timer) {
    window.clearInterval(transport.timer);
    transport.timer = 0;
  }
  transport.segments = [];
  state.playing = false;
  state.currentBeat = transport.loopEnd;
  transport.lastBeatIndex = -1;
  updatePlayUI();
  updatePositionUI(state.currentBeat);
  stage?.setTransport({ playing: false, beat: state.currentBeat });
  resetReadout();
}

function restartTransportAt() {
  if (!state.playing) {
    updatePositionUI(state.currentBeat);
    return;
  }
  const beat = visualBeatAt(audioEngine.clock());
  stopTransport({ keepBeat: beat });
  beginTransport(beat);
}

function updatePlayUI() {
  els.playIcon.textContent = state.playing ? '❚❚' : '▶';
  els.playLabel.textContent = state.playing ? '暂停' : '播放';
  els.playBtn.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  els.playBtn.classList.toggle('is-on', state.playing);
  document.body.classList.toggle('is-playing', state.playing);
  if (!state.playing) resetReadout();
}

function updatePositionUI(beat) {
  const total = totalBeats();
  const safeBeat = total > 0 ? clamp(beat, 0, total) : 0;
  const ratio = total > 0 ? safeBeat / total : 0;
  els.progressFill.style.width = `${ratio * 100}%`;
  if (!progressDragging) {
    els.progressRange.max = String(Math.max(1, total));
    els.progressRange.value = String(safeBeat);
  }
  els.currentTime.textContent = formatClock(safeBeat / bps());
  updateABMarkers();
  stage?.setTransport({
    beat: safeBeat,
    playing: state.playing,
    totalBeats: total,
    barLength: state.parsed?.meta?.timeSigNum || 4,
    ab: state.ab,
    loopMode: state.loopMode,
    metronome: state.metronome,
  });
  updatePreviewHighlight(safeBeat);
  updateReadoutForBeat(safeBeat);
}

function updateABMarkers() {
  const total = totalBeats();
  if (!validAB() || total <= 0) {
    els.progressAb.hidden = true;
    els.abStatus.textContent = '未标记';
    return;
  }
  const startRatio = clamp(state.ab.a / total, 0, 1);
  const endRatio = clamp(state.ab.b / total, 0, 1);
  els.progressAb.hidden = false;
  els.progressAb.style.left = `${startRatio * 100}%`;
  els.progressAb.style.width = `${Math.max(0.4, (endRatio - startRatio) * 100)}%`;
  els.abStatus.textContent = `A ${state.ab.a.toFixed(2)} 拍 · B ${state.ab.b.toFixed(2)} 拍`;
}

function updateMetronomeUI() {
  els.metronomeBtn.classList.toggle('is-on', state.metronome);
  els.metronomeBtn.setAttribute('aria-pressed', String(state.metronome));
  els.metronomeBtn.textContent = state.metronome ? '节拍器开' : '节拍器';
}

function updateLoopUI() {
  els.loopBtn.classList.toggle('is-on', state.loopMode === 'all');
  els.loopBtn.setAttribute('aria-pressed', String(state.loopMode === 'all'));
  els.abLoopBtn.classList.toggle('is-on', state.loopMode === 'ab');
  els.abLoopBtn.setAttribute('aria-pressed', String(state.loopMode === 'ab'));
  const label =
    state.loopMode === 'all'
      ? '整曲循环'
      : state.loopMode === 'ab' && validAB()
        ? 'A–B 循环'
        : '未循环';
  els.loopChip.textContent = label;
  els.loopChip.classList.toggle('is-active', state.loopMode !== 'off');
  els.setABtn.classList.toggle('is-on', Number.isFinite(state.ab.a));
  els.setBBtn.classList.toggle('is-on', Number.isFinite(state.ab.b));
}

function updateABUI() {
  updateABMarkers();
  updateLoopUI();
}

function setTempo(value, { applyNow = false } = {}) {
  const next = clamp(Math.round(Number(value) || 80), 20, 300);
  els.tempoValue.textContent = String(next);
  els.bpmChip.textContent = `♩=${next}`;
  if (!state.playing && state.bpm === next) return;
  if (applyNow) {
    const wasPlaying = state.playing;
    const beat = wasPlaying ? visualBeatAt(audioEngine.clock()) : state.currentBeat;
    state.bpm = next;
    els.tempoRange.value = String(next);
    updateTotalTime();
    if (wasPlaying) beginTransport(beat);
    else updatePositionUI(state.currentBeat);
  }
}

const applyTempoDebounced = debounce((value) => {
  const wasPlaying = state.playing;
  const beat = wasPlaying ? visualBeatAt(audioEngine.clock()) : state.currentBeat;
  state.bpm = clamp(Math.round(Number(value) || 80), 20, 300);
  els.tempoRange.value = String(state.bpm);
  updateTotalTime();
  if (wasPlaying) beginTransport(beat);
  else updatePositionUI(state.currentBeat);
}, 120);

function beginTempoChange(value) {
  els.tempoValue.textContent = String(Math.round(Number(value) || 80));
  els.bpmChip.textContent = `♩=${Math.round(Number(value) || 80)}`;
  applyTempoDebounced(value);
}

/* ------------------------------------------------------------------ AB / loops */

function setA() {
  if (!state.parsed) {
    toast('先载入乐谱，再标记 A 点。', 'warn', 2200);
    return;
  }
  const beat = state.playing ? visualBeatAt(audioEngine.clock()) : state.currentBeat;
  state.ab.a = clamp(beat, 0, totalBeats());
  if (Number.isFinite(state.ab.b) && state.ab.b <= state.ab.a) state.ab.b = null;
  updateABUI();
  toast(`A 点已标记在 ${state.ab.a.toFixed(2)} 拍。`, 'ok', 1800);
}

function setB() {
  if (!state.parsed) {
    toast('先载入乐谱，再标记 B 点。', 'warn', 2200);
    return;
  }
  if (!Number.isFinite(state.ab.a)) {
    toast('请先标记 A 点，再标记 B 点。', 'warn', 2400);
    return;
  }
  const beat = state.playing ? visualBeatAt(audioEngine.clock()) : state.currentBeat;
  if (beat <= state.ab.a) {
    toast('B 点需要晚于 A 点。', 'warn', 2400);
    return;
  }
  state.ab.b = clamp(beat, 0, totalBeats());
  state.loopMode = 'ab';
  updateABUI();
  const wasPlaying = state.playing;
  if (wasPlaying) beginTransport(state.ab.a);
  else {
    state.currentBeat = state.ab.a;
    updatePositionUI(state.currentBeat);
  }
  toast(`A–B 循环已启用：${state.ab.a.toFixed(2)} → ${state.ab.b.toFixed(2)} 拍。`, 'ok', 2500);
}

function toggleABLoop() {
  if (!validAB()) {
    toast('先标记 A 与 B 两点。', 'warn', 2400);
    return;
  }
  if (state.loopMode === 'ab') {
    state.loopMode = 'off';
  } else {
    state.loopMode = 'ab';
  }
  updateLoopUI();
  restartTransportAt();
}

function clearAB() {
  state.ab = { a: null, b: null };
  if (state.loopMode === 'ab') state.loopMode = 'off';
  updateLoopUI();
  updateABMarkers();
  restartTransportAt();
  toast('A–B 标记已清除。', 'info', 1800);
}

function toggleWholeLoop() {
  state.loopMode = state.loopMode === 'all' ? 'off' : 'all';
  if (state.loopMode !== 'off' && state.loopMode !== 'all') state.loopMode = 'all';
  updateLoopUI();
  restartTransportAt();
}

function toggleMetronome() {
  state.metronome = !state.metronome;
  updateMetronomeUI();
  stage?.setTransport({ metronome: state.metronome });
  if (!state.parsed) return;
  if (state.metronome && !state.playing) {
    toast('节拍器会在播放时发声。', 'info', 2200);
  }
}

/* ------------------------------------------------------------------ live keyboard */

function getMappingForCode(code, modifiers) {
  const shift = Boolean(modifiers.shift);
  const ctrl = Boolean(modifiers.ctrl);
  const instrument = currentInstrument();
  const keyOffset = currentKeyOffset();

  if (instrument.id === 'guitar') {
    if (ctrl) return null;
    if (!shift && GUITAR_OPEN[code]) {
      const stringNumber = GUITAR_OPEN[code];
      const midi = GUITAR_TUNING[stringNumber - 1] + state.octaveOffset * 12;
      return {
        midi,
        mod: 'base',
        label: `${stringNumber} 弦空弦`,
        string: stringNumber,
        fret: 0,
      };
    }
    const activeRows = GUITAR_ROWS.filter((row) => row.mod === (shift ? 'shift' : 'base'));
    for (const row of activeRows) {
      const index = row.keys.indexOf(code);
      if (index >= 0) {
        const fret = index + 1;
        const midi = GUITAR_TUNING[row.string - 1] + fret + state.octaveOffset * 12;
        return {
          midi,
          mod: shift ? 'shift' : 'base',
          label: `${row.string} 弦 ${fret} 品`,
          string: row.string,
          fret,
        };
      }
    }
    return null;
  }

  let degree = 0;
  let isHalf = false;
  if (instrument.id === 'piano') {
    if (PIANO_MAIN[code]) degree = PIANO_MAIN[code];
    else if (PIANO_SHARP[code]) {
      degree = PIANO_SHARP[code];
      isHalf = true;
    }
  } else if (LETTER_DEGREES[code]) {
    degree = LETTER_DEGREES[code];
  }
  if (!degree) return null;

  let octave = state.octaveOffset;
  if (instrument.id === 'piano') {
    if (shift) octave += 1;
    else if (ctrl) octave -= 1;
  } else {
    if (shift) {
      octave += 1;
      isHalf = false;
    } else if (ctrl) {
      isHalf = true;
    }
  }
  const midi = noteToMidi({ scale: degree, octave, isHalf }, keyOffset);
  if (midi === null) return null;
  return {
    midi,
    mod: 'base',
    label: `${isHalf ? '#' : ''}${degree}${octave > 0 ? "'".repeat(octave) : ''}`,
  };
}

async function startLiveNote(code, mapping) {
  const instrumentAtStart = state.instrumentId;
  const ok = await ensureAudio({ load: true });
  if (!ok) return;
  if (!state.heldCodes.has(code)) return;
  if (state.liveNotes.has(code)) return;
  if (state.instrumentId !== instrumentAtStart) return;

  const voice = audioEngine.playNote(mapping.midi, {
    source: 'live',
    velocity: 0.8,
    fit: true,
  });
  if (!voice) return;
  if (voice.muted) {
    if (Date.now() - (state.lastMutedToast || 0) > 1200) {
      state.lastMutedToast = Date.now();
      toast(voice.reason || '这个音超出了当前乐器音域。', 'warn', 2600);
    }
    return;
  }

  const entry = {
    code,
    voice,
    id: voice.id,
    mapping,
    mod: mapping.mod || 'base',
    startedAt: performance.now(),
    sustained: false,
    timer: 0,
  };
  entry.timer = window.setTimeout(() => {
    entry.sustained = true;
    updateLiveReadout(entry);
  }, LONG_PRESS_MS);

  state.liveNotes.set(code, entry);
  stage?.noteOn({
    id: voice.id,
    midi: voice.midi,
    velocity: 0.8,
    adjusted: voice.adjusted,
  });
  setHeldKey(code, true, entry.mod);
  updateLiveReadout(entry);
  els.stageHint?.classList.add('is-hidden');
}

function stopLiveNote(code) {
  const entry = state.liveNotes.get(code);
  state.heldCodes.delete(code);
  clearHeldKey(code);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  if (entry.voice) {
    try {
      entry.voice.stop(audioEngine.clock());
    } catch {
      /* 已经停止 */
    }
    stage?.noteOff(entry.id);
  }
  state.liveNotes.delete(code);
  if (state.liveNotes.size === 0) resetReadout();
}

function stopAllLiveNotes() {
  for (const code of [...state.liveNotes.keys()]) {
    stopLiveNote(code);
  }
  state.heldCodes.clear();
  for (const cap of els.keyboardStrip?.querySelectorAll('.keycap.is-held') || []) {
    cap.classList.remove('is-held');
  }
}

function refreshHeldNotes() {
  if (!state.liveNotes.size) return;
  for (const [code, entry] of [...state.liveNotes]) {
    if (!entry.voice) continue;
    const mapping = getMappingForCode(code, state.modifiers);
    if (!mapping || mapping.midi === entry.mapping.midi) continue;
    const voice = audioEngine.playNote(mapping.midi, {
      source: 'live',
      velocity: 0.8,
      fit: true,
    });
    if (!voice || voice.muted) continue;
    try {
      entry.voice.stop(audioEngine.clock());
    } catch {
      /* noop */
    }
    stage?.noteOff(entry.id);
    clearHeldKey(code);
    entry.voice = voice;
    entry.id = voice.id;
    entry.mapping = mapping;
    entry.mod = mapping.mod || 'base';
    stage?.noteOn({
      id: voice.id,
      midi: voice.midi,
      velocity: 0.8,
      adjusted: voice.adjusted,
    });
    setHeldKey(code, true, entry.mod);
    updateLiveReadout(entry);
  }
}

function updateLiveReadout(entry) {
  const voice = entry.voice;
  if (!voice) return;
  const degree = midiToJianpu(voice.midi, currentKeyOffset());
  const adjustText = voice.adjusted ? ' · 自动移八度' : '';
  const sustainText = entry.sustained ? ' · 延音' : '';
  const key = `live:${degree}:${voice.midi}:${adjustText}:${sustainText}`;
  if (key === state.readoutKey) return;
  state.readoutKey = key;
  const degreeEl = els.noteReadout.querySelector('.stage-note__degree');
  const nameEl = els.noteReadout.querySelector('.stage-note__name');
  degreeEl.textContent = degree;
  nameEl.textContent = `${noteNameSafe(voice.midi)} · ${currentInstrument().name}${adjustText}${sustainText}`;
}

function resetReadout() {
  if (state.liveNotes.size > 0) return;
  const key = 'idle';
  if (state.readoutKey === key) return;
  state.readoutKey = key;
  const degreeEl = els.noteReadout.querySelector('.stage-note__degree');
  const nameEl = els.noteReadout.querySelector('.stage-note__name');
  degreeEl.textContent = '—';
  nameEl.textContent = state.parsed ? '等待下一个音' : '等待第一个音';
}

function updateReadoutForBeat(beat) {
  if (state.liveNotes.size > 0) return;
  if (!state.parsed || !state.timeline || !state.playing) {
    if (!state.playing) resetReadout();
    return;
  }
  const event = state.timeline.events.find(
    (item) => beat >= item.startBeat && beat < item.startBeat + item.durationBeats
  );
  if (!event) {
    resetReadout();
    return;
  }
  const midi = noteToMidi(event.note, state.parsed.meta.keyOffset);
  if (midi === null) return;
  const fit = fitMidiToRange(midi, currentInstrument().minMidi, currentInstrument().maxMidi);
  const degree = midiToJianpu(midi, currentKeyOffset());
  const key = `score:${event.index}:${beat < event.startBeat + 0.2}`;
  if (key === state.readoutKey) return;
  state.readoutKey = key;
  const degreeEl = els.noteReadout.querySelector('.stage-note__degree');
  const nameEl = els.noteReadout.querySelector('.stage-note__name');
  degreeEl.textContent = degree;
  nameEl.textContent = `${noteNameSafe(midi)} · ${currentInstrument().name}${fit.adjusted ? ' · 自动移八度' : ''}`;
}

/* ------------------------------------------------------------------ keyboard events */

function isBodyTarget(target) {
  return target === document.body || target === document.documentElement;
}

function handleKeyDown(event) {
  state.modifiers = { shift: event.shiftKey, ctrl: event.ctrlKey };
  if (isEditableTarget(event.target)) return;

  if (event.code === 'Escape') {
    stopAllLiveNotes();
    if (state.playing) pausePlayback();
    return;
  }

  if (event.code === 'Space' && isBodyTarget(event.target) && !event.repeat && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    if (state.playing) pausePlayback();
    else startPlayback();
    return;
  }

  if (event.metaKey || event.altKey) return;

  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.code === 'ControlLeft' || event.code === 'ControlRight') {
    refreshHeldNotes();
    return;
  }

  const mapping = getMappingForCode(event.code, state.modifiers);
  if (!mapping) return;
  event.preventDefault();
  if (event.repeat) return;
  if (state.liveNotes.has(event.code)) return;
  state.heldCodes.add(event.code);
  void startLiveNote(event.code, mapping);
}

function handleKeyUp(event) {
  state.modifiers = { shift: event.shiftKey, ctrl: event.ctrlKey };

  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight' || event.code === 'ControlLeft' || event.code === 'ControlRight') {
    refreshHeldNotes();
    return;
  }

  if (state.liveNotes.has(event.code) || state.heldCodes.has(event.code)) {
    stopLiveNote(event.code);
  }
}

/* ------------------------------------------------------------------ progress & UI loop */

function seekTo(beat) {
  const total = totalBeats();
  state.currentBeat = total > 0 ? clamp(Number(beat) || 0, 0, total) : 0;
  updatePositionUI(state.currentBeat);
}

function handleProgressInput(event) {
  if (!state.parsed) return;
  if (state.playing && !state.scrubbing && !state.resumeAfterScrub) {
    state.resumeAfterScrub = true;
    pausePlayback({ silent: true });
  }
  seekTo(Number(event.target.value));
}

function handleProgressChange(event) {
  if (!state.parsed) return;
  seekTo(Number(event.target.value));
  state.scrubbing = false;
  progressDragging = false;
  if (state.resumeAfterScrub) {
    state.resumeAfterScrub = false;
    startPlayback();
  }
}

function uiTick() {
  if (state.playing) {
    const now = audioEngine.clock();
    if (!transport.loop && now >= transport.endTime + 0.32) {
      finishPlayback();
    } else {
      const beat = visualBeatAt(now);
      state.currentBeat = beat;
      updatePositionUI(beat);
      const beatIndex = Math.floor(beat);
      if (beatIndex !== transport.lastBeatIndex) {
        transport.lastBeatIndex = beatIndex;
        const barLength = state.parsed?.meta?.timeSigNum || 4;
        const accent = Math.abs(beatIndex % barLength) < 1e-9;
        stage?.pulseBeat(accent);
      }
    }
  }
  requestAnimationFrame(uiTick);
}

/* ------------------------------------------------------------------ misc bindings */

function bindControls() {
  els.playBtn.addEventListener('click', () => {
    startPlayback();
  });
  els.stopBtn.addEventListener('click', () => {
    stopAllLiveNotes();
    pausePlayback({ reset: true });
  });
  els.metronomeBtn.addEventListener('click', toggleMetronome);
  els.loopBtn.addEventListener('click', toggleWholeLoop);
  els.setABtn.addEventListener('click', setA);
  els.setBBtn.addEventListener('click', setB);
  els.abLoopBtn.addEventListener('click', toggleABLoop);
  els.clearABtn.addEventListener('click', clearAB);

  els.tempoRange.addEventListener('input', (event) => beginTempoChange(event.target.value));
  els.tempoRange.addEventListener('change', (event) => {
    setTempo(event.target.value, { applyNow: true });
  });

  els.masterVolume.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    els.masterVolumeValue.textContent = `${Math.round(value)}%`;
    audioEngine.setMasterVolume(value / 100);
  });

  els.instrumentVolume.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    els.instrumentVolumeValue.textContent = `${Math.round(value)}%`;
    audioEngine.setInstrumentVolume(value / 100);
  });

  els.reverbMix.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    els.reverbMixValue.textContent = `${Math.round(value)}%`;
    audioEngine.setReverbMix(value / 100);
  });

  els.reverbToggle.addEventListener('click', () => {
    const enabled = els.reverbToggle.getAttribute('aria-pressed') !== 'true';
    els.reverbToggle.setAttribute('aria-pressed', String(enabled));
    els.reverbToggle.classList.toggle('is-on', enabled);
    els.reverbToggle.textContent = enabled ? '混响开' : '混响关';
    audioEngine.setReverbEnabled(enabled);
  });

  els.reverbPreset.addEventListener('change', (event) => {
    audioEngine.setReverbPreset(event.target.value);
    toast(`混响预设：${event.target.value === 'short' ? '短混响' : '长混响'}。`, 'info', 1800);
  });

  els.octaveSelector.addEventListener('click', (event) => {
    const button = event.target.closest('[data-octave]');
    if (!button) return;
    state.octaveOffset = Number(button.dataset.octave);
    for (const item of els.octaveSelector.querySelectorAll('[data-octave]')) {
      item.classList.toggle('is-active', Number(item.dataset.octave) === state.octaveOffset);
    }
    // 基准八度变化会改变所有正在按住的键。
    refreshHeldNotes();
    toast(`键盘基准八度：${state.octaveOffset > 0 ? '+' : ''}${state.octaveOffset}`, 'info', 1600);
  });

  els.chordsToggle?.addEventListener('click', () => {
    const enabled = els.chordsToggle.getAttribute('aria-pressed') !== 'true';
    els.chordsToggle.setAttribute('aria-pressed', String(enabled));
    els.chordsToggle.classList.toggle('is-on', enabled);
    els.chordsToggle.textContent = enabled ? '开' : '关';
    state.chordsEnabled = enabled;
    audioEngine.setChordEnabled(enabled);
    if (enabled) {
      const info = state.chordTrack?.events?.length
        ? `已为 ${state.chordTrack.barCount} 小节生成和弦：${state.chordTrack.chords.slice(0, 8).join(' · ')}${state.chordTrack.chords.length > 8 ? ' …' : ''}`
        : '载入乐谱后会自动按小节配和弦。';
      if (els.chordInfo) els.chordInfo.textContent = info;
      toast('和弦伴奏已开启，重新播放即可听到效果。', 'ok', 2600);
    } else {
      if (els.chordInfo) els.chordInfo.textContent = '开启后按小节自动配三和弦与低音，与旋律同时播放。';
    }
  });

  els.chordVolume?.addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state.chordVolume = value / 100;
    els.chordVolumeValue.textContent = `${value}%`;
    audioEngine.setChordVolume(state.chordVolume);
  });

  els.saveSongBtn?.addEventListener('click', addToLibrary);
  els.libraryList?.addEventListener('click', handleLibraryClick);

  els.parseBtn.addEventListener('click', () => loadScore(els.scoreInput.value));
  els.sampleBtn.addEventListener('click', () => {
    els.scoreInput.value = DEFAULT_SCORE;
    loadScore(DEFAULT_SCORE);
  });
  els.clearBtn.addEventListener('click', clearScore);
  els.scoreInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      loadScore(els.scoreInput.value);
    }
  });

  els.copyAiPromptBtn.addEventListener('click', async () => {
    const ok = await copyText(AI_PROMPT_TEXT);
    toast(
      ok
        ? '已复制格式说明，发给 AI 生成简谱后粘贴回来即可。'
        : '复制失败，请检查浏览器剪贴板权限后重试。',
      ok ? 'ok' : 'warn',
      3000
    );
  });

  els.searchBtn.addEventListener('click', openSearch);
  els.searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openSearch();
    }
  });

  els.arrangeBtn.addEventListener('click', runArrangement);
  els.arrangeCards.addEventListener('click', handleArrangementClick);

  els.progressRange.addEventListener('pointerdown', () => {
    progressDragging = true;
    state.scrubbing = true;
    if (state.playing) {
      state.resumeAfterScrub = true;
      pausePlayback({ silent: true });
    }
  });
  els.progressRange.addEventListener('input', handleProgressInput);
  els.progressRange.addEventListener('change', handleProgressChange);
  els.progressRange.addEventListener('pointerup', () => {
    if (state.scrubbing) {
      state.scrubbing = false;
      progressDragging = false;
      if (state.resumeAfterScrub) {
        state.resumeAfterScrub = false;
        startPlayback();
      }
    }
  });

  els.audioWakeBtn.addEventListener('click', async () => {
    const ok = await ensureAudio({ load: true });
    if (ok) toast('声音已唤醒。', 'ok', 2000);
  });

  els.retrySoundfontBtn.addEventListener('click', async () => {
    els.retrySoundfontBtn.disabled = true;
    toast('正在重试加载采样音色…', 'info', 2200);
    await audioEngine.retrySoundfont();
    els.retrySoundfontBtn.disabled = false;
    updateAudioUI();
  });

  els.panelToggle.addEventListener('click', () => toggleDrawer(true));
  els.panelClose.addEventListener('click', () => toggleDrawer(false));
  els.panelBackdrop.addEventListener('click', () => toggleDrawer(false));

  // 虚拟琴键：指针按下等同于对应物理键按下，松开则停止。
  let pointerKeyCode = null;
  els.keyboardStrip?.addEventListener('pointerdown', (event) => {
    const cap = event.target.closest('.keycap[data-code]');
    if (!cap || cap.classList.contains('keycap--empty')) return;
    event.preventDefault();
    const code = cap.dataset.code;
    const mod = cap.dataset.mod || 'base';
    const modifiers = { shift: mod === 'shift', ctrl: false };
    const mapping = getMappingForCode(code, modifiers);
    if (!mapping) return;
    if (state.liveNotes.has(code)) stopLiveNote(code);
    pointerKeyCode = code;
    try { cap.setPointerCapture(event.pointerId); } catch { /* noop */ }
    state.heldCodes.add(code);
    void startLiveNote(code, mapping);
  });
  const releasePointerKey = () => {
    if (pointerKeyCode && (state.liveNotes.has(pointerKeyCode) || state.heldCodes.has(pointerKeyCode))) {
      stopLiveNote(pointerKeyCode);
    }
    pointerKeyCode = null;
  };
  els.keyboardStrip?.addEventListener('pointerup', releasePointerKey);
  els.keyboardStrip?.addEventListener('pointercancel', releasePointerKey);

  window.addEventListener('keydown', handleKeyDown, { passive: false });
  window.addEventListener('keyup', handleKeyUp, { passive: false });
  window.addEventListener('blur', () => {
    stopAllLiveNotes();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopAllLiveNotes();
  });

  window.addEventListener('pointerdown', primeAudio, { once: true, capture: true });
  window.addEventListener('keydown', primeAudio, { once: true, capture: true });
}

function toggleDrawer(open) {
  const isTablet = window.matchMedia('(max-width: 1199px) and (min-width: 768px)').matches;
  if (!isTablet) {
    els.controlPanel.classList.remove('is-open');
    els.panelBackdrop.hidden = true;
    els.panelToggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('drawer-open');
    return;
  }
  els.controlPanel.classList.toggle('is-open', open);
  els.panelBackdrop.hidden = !open;
  els.panelToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('drawer-open', open);
}

function openSearch() {
  const query = els.searchInput.value.trim();
  if (!query) {
    toast('先输入曲名，例如「茉莉花」。', 'warn', 2400);
    els.searchInput.focus();
    return;
  }
  if (query.length > 80) {
    toast('曲名太长了，请控制在 80 个字符以内。', 'warn', 2600);
    return;
  }
  const engine = SEARCH_ENGINES[els.searchEngine.value] || SEARCH_ENGINES.bing;
  const url = `${engine.url}${encodeURIComponent(`${query} 简谱 文本`)}`;
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    toast('浏览器拦截了搜索窗口，请允许弹出窗口后重试。', 'warn', 3200);
  } else {
    toast(`已在${engine.name}打开搜索，请复制简谱文本回到输入框。`, 'info', 2800);
  }
}

function runArrangement() {
  if (!state.parsed) {
    const text = els.scoreInput.value.trim();
    if (text) {
      const ok = loadScore(text, { announce: false });
      if (!ok) return;
    } else {
      toast('先载入一份乐谱，再进行智能编配。', 'warn', 2600);
      return;
    }
  }
  const result = arrangeScore(state.parsed);
  if (!result) {
    toast('没有足够的音符数据用于编配。', 'warn', 2600);
    return;
  }
  renderArrangement(result);
  toast(`已生成「${result.genre}」编配建议。`, 'ok', 2400);
}

/* ------------------------------------------------------------------ init */

function init() {
  state.theme = loadTheme();
  stage = new StageRenderer(els.stageCanvas, { clock: () => audioEngine.clock() });
  stage.setTheme(state.theme);
  stage.setInstrument(state.instrumentId);
  stage.start();

  audioEngine.setInstrument(state.instrumentId);
  audioEngine.setMasterVolume(Number(els.masterVolume.value) / 100);
  audioEngine.setInstrumentVolume(Number(els.instrumentVolume.value) / 100);
  audioEngine.setReverbMix(Number(els.reverbMix.value) / 100);
  audioEngine.setReverbEnabled(true);
  audioEngine.setChordVolume(state.chordVolume);
  audioEngine.setChordEnabled(state.chordsEnabled);

  buildInstrumentButtons();
  buildInstrumentTable();
  buildKeyboardStrip();
  applyThemeToUI();
  bindControls();
  bindThemePanelWhenReady();
  renderLibrary();

  els.reverbPreset.value = currentInstrument().reverb;
  els.scoreInput.value = DEFAULT_SCORE;
  loadScore(DEFAULT_SCORE, { announce: false });
  updateAudioUI();
  updatePlayUI();
  updateMetronomeUI();
  updateLoopUI();
  updateABUI();
  updatePositionUI(0);
  resetReadout();

  window.addEventListener('error', (event) => {
    console.error('[FloatNote] uncaught error:', event.error || event.message);
  });
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[FloatNote] unhandled rejection:', event.reason);
    toast('发生了一个意外错误，已输出到控制台。', 'error', 4200);
  });

  requestAnimationFrame(uiTick);
}

init();
