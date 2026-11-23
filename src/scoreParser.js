/**
 * FloatNote · 文本简谱解析器
 *
 * 支持的书写约定：
 *   1=C 4/4 ♩=80
 *   1 2 3 4 5 6 7
 *   1.  低音 1 / 1' 高音 1 / #1 升半音
 *   1-  二分音符 / 1_ 八分音符 / 单独的 - 延长前一个音
 *   1~  连音线
 *   |   小节线
 *   0   休止符（兼容扩展）
 *
 * 解析结果只包含文档约定的音符字段；拍号、调号、速度放在 meta 中。
 */

export const DEFAULT_META = Object.freeze({ key: 'C', timeSig: '4/4', bpm: 80 });

export const KEY_SEMITONES = Object.freeze({
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
  'B#': 0,
});

export const SCALE_INTERVALS = Object.freeze([0, 2, 4, 5, 7, 9, 11]);

export const DEFAULT_SCORE = `1=C 4/4 ♩=84
1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |
5 5 4 4 | 3 3 2 - | 5 5 4 4 | 3 3 2 - |
1 1 5 5 | 6 6 5 - | 4 4 3 3 | 2 2 1 - |`;

const MAX_ERRORS = 12;
const MAX_WARNINGS = 24;

const NORMALIZE_MAP = new Map([
  ['｜', '|'],
  ['丨', '|'],
  ['♯', '#'],
  ['♭', 'b'],
  ['’', "'"],
  ['‘', "'"],
  ['‘', "'"],
  ['。', '.'],
  ['～', '~'],
  ['〜', '~'],
  ['—', '-'],
  ['–', '-'],
  ['_', '_'],
  ['，', ' '],
  [',', ' '],
  ['；', ' '],
  [';', ' '],
  ['　', ' '],
]);

const KEY_LOOKUP = new Map(
  Object.entries(KEY_SEMITONES).map(([name, offset]) => [name.toLowerCase(), { name, offset }])
);

function normalizeNotation(text) {
  let value = String(text ?? '');
  try {
    value = value.normalize('NFKC');
  } catch {
    /* 某些旧浏览器不支持 normalize，继续处理 */
  }
  let out = '';
  for (const char of value) {
    out += NORMALIZE_MAP.get(char) ?? char;
  }
  return out.replace(/\r\n?/g, '\n');
}

function createLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}

function makeIssue(locator, index, message, token = '') {
  return { ...locator(index), index, message, token };
}

function normalizeKey(rawLetter, rawAccidental) {
  const letter = String(rawLetter || '').toUpperCase();
  const accidental = String(rawAccidental || '').replace('♯', '#').replace('♭', 'b');
  const name = `${letter}${accidental}`;
  return KEY_LOOKUP.get(name.toLowerCase()) || null;
}

function parseTimeSignature(num, den) {
  const n = Number(num);
  const d = Number(den);
  if (!Number.isInteger(n) || !Number.isInteger(d)) return null;
  if (n < 1 || n > 12) return null;
  if (![2, 4, 8, 16].includes(d)) return null;
  return { num: n, den: d, beatsPerBar: n * (4 / d), text: `${n}/${d}` };
}

function parseBpmToken(digits, locator, index, warnings) {
  const lengths = [];
  for (let len = Math.min(3, digits.length); len >= 2; len -= 1) lengths.push(len);
  for (const len of lengths) {
    const value = Number(digits.slice(0, len));
    if (value >= 20 && value <= 300) {
      const remainder = digits.slice(len);
      return {
        bpm: value,
        remainder,
        remainderIndex: remainder ? index + digits.length - remainder.length : null,
      };
    }
  }
  warnings.push(
    makeIssue(locator, index, `速度 ${digits} 超出 20–300 BPM 范围，已使用默认 ${DEFAULT_META.bpm} BPM。`, digits)
  );
  return { bpm: null, remainder: '', remainderIndex: null };
}

function finalizeBars(notes, meta, locator, warnings) {
  if (!notes.length) return;
  const byBar = new Map();
  for (const note of notes) {
    const entry = byBar.get(note.barIndex) || { beats: 0, count: 0, first: null };
    entry.beats += note.duration;
    entry.count += 1;
    if (!entry.first) entry.first = note;
    byBar.set(note.barIndex, entry);
  }
  const maxBar = Math.max(...notes.map((n) => n.barIndex));
  for (let bar = 0; bar <= maxBar; bar += 1) {
    const entry = byBar.get(bar);
    if (!entry) {
      if (bar !== maxBar) {
        warnings.push({
          line: 0,
          col: 0,
          index: -1,
          token: '',
          message: `第 ${bar + 1} 小节没有音符。`,
        });
      }
      continue;
    }
    if (Math.abs(entry.beats - meta.beatsPerBar) > 1e-6) {
      const beats = Number(entry.beats.toFixed(3));
      warnings.push({
        line: 0,
        col: 0,
        index: -1,
        token: '',
        message: `第 ${bar + 1} 小节共 ${beats} 拍，与 ${meta.timeSig} 的 ${meta.beatsPerBar} 拍不一致。`,
      });
    }
  }
  if (warnings.length > MAX_WARNINGS) warnings.length = MAX_WARNINGS;
}

/**
 * 解析简谱文本。
 * @param {string} text
 * @returns {{
 *   ok: boolean, meta: object, notes: object[], errors: object[], warnings: object[],
 *   stats: object, rawText: string
 * }}
 */
export function parseScore(text) {
  const locator = createLocator(String(text ?? ''));
  const warnings = [];
  const errors = [];
  const meta = {
    key: DEFAULT_META.key,
    timeSig: DEFAULT_META.timeSig,
    bpm: DEFAULT_META.bpm,
    keyOffset: 0,
    beatsPerBar: 4,
    timeSigNum: 4,
    timeSigDen: 4,
  };

  if (typeof text !== 'string' || !text.trim()) {
    return {
      ok: false,
      meta,
      notes: [],
      errors: [{ line: 1, col: 1, index: 0, token: '', message: '请输入简谱文本。' }],
      warnings: [],
      stats: emptyStats(),
      rawText: String(text ?? ''),
    };
  }

  const norm = normalizeNotation(text);
  const firstIndex = norm.search(/\S/);
  if (firstIndex === -1) {
    return {
      ok: false,
      meta,
      notes: [],
      errors: [{ line: 1, col: 1, index: 0, token: '', message: '请输入简谱文本。' }],
      warnings: [],
      stats: emptyStats(),
      rawText: String(text ?? ''),
    };
  }

  let firstLineEnd = norm.indexOf('\n', firstIndex);
  if (firstLineEnd === -1) firstLineEnd = norm.length;

  let cursor = firstIndex;
  let consumedHeader = false;
  let syntheticToken = null;

  while (cursor < firstLineEnd) {
    while (cursor < firstLineEnd && /\s/.test(norm[cursor])) cursor += 1;
    if (cursor >= firstLineEnd) break;
    const rest = norm.slice(cursor, firstLineEnd);

    const keyMatch = rest.match(/^1\s*=\s*([A-Ga-g])([#b]?)(?=\s|$)/);
    if (keyMatch) {
      const key = normalizeKey(keyMatch[1], keyMatch[2]);
      if (key) {
        meta.key = key.name;
        meta.keyOffset = key.offset;
      } else {
        warnings.push(
          makeIssue(locator, cursor, `无法识别调号 1=${keyMatch[1]}${keyMatch[2] || ''}，已使用 C 调。`, keyMatch[0])
        );
      }
      cursor += keyMatch[0].length;
      consumedHeader = true;
      continue;
    }

    const timeMatch = rest.match(/^(\d{1,3})\s*\/\s*(\d{1,3})(?=\s|$)/);
    if (timeMatch) {
      const time = parseTimeSignature(timeMatch[1], timeMatch[2]);
      if (time) {
        meta.timeSig = time.text;
        meta.timeSigNum = time.num;
        meta.timeSigDen = time.den;
        meta.beatsPerBar = time.beatsPerBar;
      } else {
        warnings.push(
          makeIssue(
            locator,
            cursor,
            `无法识别拍号 ${timeMatch[1]}/${timeMatch[2]}，已使用 4/4 拍。`,
            timeMatch[0]
          )
        );
      }
      cursor += timeMatch[0].length;
      consumedHeader = true;
      continue;
    }

    const bpmMatch = rest.match(/^(?:♩|q|BPM|bpm|速度)\s*[=:]?\s*(\d+)/i);
    if (bpmMatch) {
      const digits = bpmMatch[1];
      const digitsOffset = cursor + bpmMatch[0].lastIndexOf(digits);
      const parsed = parseBpmToken(digits, locator, digitsOffset, warnings);
      if (parsed.bpm) meta.bpm = parsed.bpm;
      if (parsed.remainder) {
        syntheticToken = { text: parsed.remainder, index: parsed.remainderIndex };
      }
      cursor += bpmMatch[0].length;
      consumedHeader = true;
      continue;
    }

    // 看起来像声明但值不合法时，给出降级提示，不把 1=H 当成音符。
    const badKey = rest.match(/^1\s*=\s*([^\s|]+)/);
    if (badKey) {
      warnings.push(
        makeIssue(locator, cursor, `无法识别调号 ${badKey[0]}，已使用 C 调。`, badKey[0])
      );
      cursor += badKey[0].length;
      consumedHeader = true;
      continue;
    }

    const badTime = rest.match(/^(\d+)\s*\/\s*(\d+)/);
    if (badTime) {
      warnings.push(
        makeIssue(locator, cursor, `无法识别拍号 ${badTime[0]}，已使用 4/4 拍。`, badTime[0])
      );
      cursor += badTime[0].length;
      consumedHeader = true;
      continue;
    }

    // 第一个非声明 token 视为乐谱正文开始。
    break;
  }

  const bodyStart = cursor;
  const notes = [];
  let barIndex = 0;
  let currentBarHasNotes = false;
  let i = bodyStart;

  const addError = (index, message, token) => {
    if (errors.length < MAX_ERRORS) errors.push(makeIssue(locator, index, message, token));
  };

  const pushNote = (note, index, token) => {
    notes.push(note);
    currentBarHasNotes = true;
    if (note.scale === 0 && note.isHalf) {
      addError(index, '休止符 0 不能带升号。', token);
    }
  };

  const parseOneToken = (token, index) => {
    if (!token) return;

    if (/^-+$/.test(token)) {
      const previous = notes[notes.length - 1];
      if (!previous) {
        addError(index, `延长记号 “${token}” 前面没有可延长的音符。`, token);
        return;
      }
      if (previous.duration + token.length > 32) {
        addError(index, '单个音符的时值过长（超过 32 拍）。', token);
        return;
      }
      previous.duration += token.length;
      return;
    }

    if (/^~+$/.test(token)) {
      const previous = notes[notes.length - 1];
      if (!previous) {
        addError(index, '连音记号 “~” 前面没有音符。', token);
        return;
      }
      previous.tie = true;
      return;
    }

    let rest = token;
    let tie = false;
    while (rest.endsWith('~')) {
      tie = true;
      rest = rest.slice(0, -1);
    }

    let isHalf = false;
    if (rest.startsWith('#')) {
      isHalf = true;
      rest = rest.slice(1);
    } else if (/^b[0-7]/.test(rest)) {
      addError(index, `暂不支持降号 “${token}”，请使用等音升号（例如 b2 写作 #1）。`, token);
      return;
    }

    let octave = 0;
    let octaveText = '';
    let duration = 1;
    const match = rest.match(/^([0-7])([.'’]*?)(_*)(-*)$/);
    if (!match) {
      addError(
        index,
        `无法识别的音符 “${token}”。可用格式：1 / 1. / 1' / #1 / 1_ / 1- / 1~。`,
        token
      );
      return;
    }

    const scale = Number(match[1]);
    octaveText = match[2] || '';
    for (const char of octaveText) {
      if (char === '.') octave -= 1;
      else if (char === "'" || char === '’') octave += 1;
    }

    const underscores = (match[3] || '').length;
    if (underscores > 4) {
      addError(index, '时值下划线 “_” 最多支持 4 个。', token);
      return;
    }
    if (octave < -2 || octave > 2) {
      warnings.push(
        makeIssue(locator, index, `八度标记超过两档，已限制在 ±2 八度内。`, token)
      );
      octave = Math.max(-2, Math.min(2, octave));
    }

    duration = 1 / Math.pow(2, underscores) + (match[4] || '').length;

    if (duration <= 0 || duration > 32) {
      addError(index, `音符 “${token}” 的时值不合法。`, token);
      return;
    }

    pushNote(
      {
        scale,
        octave,
        isHalf,
        duration,
        tie,
        barIndex,
      },
      index,
      token
    );
  };

  if (syntheticToken) {
    parseOneToken(syntheticToken.text, syntheticToken.index ?? bodyStart);
  }

  while (i < norm.length) {
    const char = norm[i];
    if (char === '\n' || char === ' ' || char === '\t') {
      i += 1;
      continue;
    }
    if (char === '|') {
      const previousNonSpace = (() => {
        let j = i - 1;
        while (j >= 0 && /\s/.test(norm[j])) j -= 1;
        return j >= 0 ? norm[j] : '';
      })();
      if (notes.length === 0 && barIndex === 0) {
        i += 1;
        continue;
      }
      if (previousNonSpace === '|') {
        i += 1;
        continue;
      }
      barIndex += 1;
      currentBarHasNotes = false;
      i += 1;
      continue;
    }

    const start = i;
    while (i < norm.length && !/[\s|]/.test(norm[i])) i += 1;
    const token = norm.slice(start, i);
    parseOneToken(token, start);
    if (errors.length >= MAX_ERRORS) break;
  }

  if (errors.length) {
    return {
      ok: false,
      meta,
      notes,
      errors,
      warnings,
      stats: computeStats(notes, meta),
      rawText: String(text),
    };
  }

  if (!notes.length) {
    return {
      ok: false,
      meta,
      notes: [],
      errors: [
        {
          ...makeIssue(locator, bodyStart, '没有找到可演奏的音符。请检查简谱格式。', ''),
        },
      ],
      warnings,
      stats: emptyStats(),
      rawText: String(text),
    };
  }

  finalizeBars(notes, meta, locator, warnings);

  return {
    ok: true,
    meta,
    notes,
    errors: [],
    warnings,
    stats: computeStats(notes, meta),
    rawText: String(text),
  };
}

function emptyStats() {
  return {
    noteCount: 0,
    bars: 0,
    totalBeats: 0,
    density: 0,
    range: null,
  };
}

function computeStats(notes, meta) {
  const sounding = notes.filter((n) => n.scale > 0);
  const totalBeats = notes.reduce((sum, n) => sum + n.duration, 0);
  const midiValues = sounding
    .map((n) => noteToMidi(n, meta.keyOffset))
    .filter((v) => v !== null);
  const min = midiValues.length ? Math.min(...midiValues) : null;
  const max = midiValues.length ? Math.max(...midiValues) : null;
  const bars = notes.length ? Math.max(...notes.map((n) => n.barIndex)) + 1 : 0;
  return {
    noteCount: sounding.length,
    bars,
    totalBeats,
    density: totalBeats > 0 ? sounding.length / totalBeats : 0,
    range: min === null ? null : { minMidi: min, maxMidi: max, span: max - min },
  };
}

/** 简谱音级 → MIDI。keyOffset 可直接传 meta.keyOffset 或 meta。 */
export function noteToMidi(note, keyOffset = 0) {
  if (!note || !Number.isInteger(note.scale) || note.scale < 1 || note.scale > 7) return null;
  const offset =
    typeof keyOffset === 'object' && keyOffset !== null
      ? Number(keyOffset.keyOffset) || 0
      : Number(keyOffset) || 0;
  return (
    60 +
    offset +
    SCALE_INTERVALS[note.scale - 1] +
    (note.isHalf ? 1 : 0) +
    (Number(note.octave) || 0) * 12
  );
}

/** MIDI → 当前调下的简谱显示（含八度与升号）。 */
export function midiToJianpu(midi, keyOffset = 0) {
  if (!Number.isFinite(midi)) return '—';
  const offset =
    typeof keyOffset === 'object' && keyOffset !== null
      ? Number(keyOffset.keyOffset) || 0
      : Number(keyOffset) || 0;
  const relative = Math.round(midi) - (60 + offset);
  const octave = Math.floor(relative / 12);
  let semitone = ((relative % 12) + 12) % 12;
  let accidental = '';
  let degree = 0;

  const degreeMap = new Map([
    [0, 1],
    [2, 2],
    [4, 3],
    [5, 4],
    [7, 5],
    [9, 6],
    [11, 7],
  ]);
  if (degreeMap.has(semitone)) {
    degree = degreeMap.get(semitone);
  } else {
    // 用升号表示中间音：#1 #2 #4 #5 #6
    const lowered = [1, 3, 6, 8, 10].includes(semitone) ? semitone - 1 : semitone;
    degree = degreeMap.get(lowered) || 1;
    accidental = '#';
  }

  const low = octave < 0 ? '.'.repeat(-octave) : '';
  const high = octave > 0 ? "'".repeat(octave) : '';
  return `${accidental}${degree}${low}${high}`;
}

export function formatNoteToken(note) {
  if (!note) return '';
  const scale = Number(note.scale) || 0;
  if (scale === 0) return `0${durationSuffix(note)}${note.tie ? '~' : ''}`;
  const accidental = note.isHalf ? '#' : '';
  const octave = note.octave < 0 ? '.'.repeat(-note.octave) : note.octave > 0 ? "'".repeat(note.octave) : '';
  return `${accidental}${scale}${octave}${durationSuffix(note)}${note.tie ? '~' : ''}`;
}

function durationSuffix(note) {
  const duration = Number(note.duration) || 1;
  if (Math.abs(duration - 0.5) < 1e-9) return '_';
  if (Math.abs(duration - 0.25) < 1e-9) return '__';
  if (Math.abs(duration - 1) < 1e-9) return '';
  if (duration > 1) {
    const whole = Math.floor(duration);
    const remainder = duration - whole;
    let suffix = '-'.repeat(whole - 1);
    if (remainder >= 0.5) suffix += '_';
    return suffix;
  }
  return `_${duration}`;
}

export function samePitch(a, b) {
  if (!a || !b) return false;
  return (
    a.scale === b.scale &&
    a.octave === b.octave &&
    Boolean(a.isHalf) === Boolean(b.isHalf)
  );
}

/**
 * 把音符平铺成带起始拍号的播放事件，并合并连音线。
 * 休止符只推进时间，不产生事件。
 */
export function buildTimeline(notes) {
  const events = [];
  let beat = 0;
  let totalBeats = 0;
  let i = 0;
  while (i < notes.length) {
    const note = notes[i];
    if (note.scale === 0) {
      beat += note.duration;
      totalBeats += note.duration;
      i += 1;
      continue;
    }

    let duration = note.duration;
    let j = i;
    while (
      notes[j].tie &&
      notes[j + 1] &&
      notes[j + 1].scale > 0 &&
      samePitch(notes[j], notes[j + 1])
    ) {
      duration += notes[j + 1].duration;
      j += 1;
    }
    const consumed = duration;
    events.push({
      index: i,
      startBeat: beat,
      durationBeats: duration,
      tieGroup: j > i,
      note,
    });
    beat += consumed;
    totalBeats += consumed;
    i = j + 1;
  }
  return { events, totalBeats };
}

export function formatBpm(value) {
  const bpm = Number(value);
  return Number.isFinite(bpm) ? Math.round(bpm) : DEFAULT_META.bpm;
}
