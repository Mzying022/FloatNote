/**
 * FloatNote · 和弦伴奏生成
 * 纯本地规则：按调性构建自然大/小调音阶，逐小节用旋律音投票选出最贴切的三和弦，
 * 输出低音 + 和弦音的时间线，交给调度器与旋律同时发声。
 */

import { SCALE_INTERVALS } from './scoreParser.js';

// 各级三和弦在大调里的音级（1-based degree），小写代表小三和弦。
const MAJOR_TRIADS = [
  { name: 'I', degree: 1, degrees: [1, 3, 5], quality: 'major' },
  { name: 'ii', degree: 2, degrees: [2, 4, 6], quality: 'minor' },
  { name: 'iii', degree: 3, degrees: [3, 5, 7], quality: 'minor' },
  { name: 'IV', degree: 4, degrees: [4, 6, 1], quality: 'major' },
  { name: 'V', degree: 5, degrees: [5, 7, 2], quality: 'major' },
  { name: 'vi', degree: 6, degrees: [6, 1, 3], quality: 'minor' },
];

const MINOR_TRIADS = [
  { name: 'i', degree: 1, degrees: [1, 3, 5], quality: 'minor' },
  { name: 'ii°', degree: 2, degrees: [2, 4, 6], quality: 'dim' },
  { name: 'III', degree: 3, degrees: [3, 5, 7], quality: 'major' },
  { name: 'iv', degree: 4, degrees: [4, 6, 1], quality: 'minor' },
  { name: 'V', degree: 5, degrees: [5, 7, 2], quality: 'major' },
  { name: 'VI', degree: 6, degrees: [6, 1, 3], quality: 'major' },
];

// 每个音级相对主音的半音数（大调）；小调用下面的 MINOR_SCALE 覆盖。
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

function triadMidis(triad, tonicMidi, scale, octaveBase) {
  return triad.degrees.map((degree) => {
    const semitone = scale[degree - 1];
    // 把和弦音放进低音区（默认 C3 附近），保持声部顺序不倒置太多。
    const midi = octaveBase + semitone;
    return midi;
  });
}

/** 判断旋律更偏大调还是小调：统计第三级、第六级、第七级是否常以降三级形态出现。 */
function detectMode(midis, keyOffset) {
  if (!midis.length) return 'major';
  const pcs = new Set(midis.map((m) => ((m - 60 - keyOffset) % 12 + 12) % 12));
  const minorHits = [3, 8, 10].filter((pc) => pcs.has(pc)).length;
  const majorHits = [4, 9, 11].filter((pc) => pcs.has(pc)).length;
  return minorHits > majorHits ? 'minor' : 'major';
}

/**
 * 依据乐谱生成和弦时间线。
 * @param {object} parsed parseScore 的结果
 * @param {object} timeline buildTimeline 的结果
 * @returns {{events: Array, key: string, mode: string, barCount: number, chords: string[]}}
 */
export function buildChordTrack(parsed, timeline) {
  const empty = { events: [], key: 'C', mode: 'major', barCount: 0, chords: [] };
  if (!parsed?.ok || !timeline?.events?.length) return empty;

  const meta = parsed.meta || {};
  const keyOffset = Number(meta.keyOffset) || 0;
  const barLength = Math.max(1, Number(meta.timeSigNum) || 4);
  const tonicMidi = 60 + keyOffset; // C4 + 调性偏移
  const { events: noteEvents, totalBeats } = timeline;
  const barCount = Math.max(1, Math.ceil(totalBeats / barLength));

  const mode = detectMode(
    noteEvents
      .filter((e) => e.note?.scale > 0)
      .map((e) => {
        const n = e.note;
        return 60 + keyOffset + 12 * (Number(n.octave) || 0) + SCALE_INTERVALS[n.scale - 1] + (n.isHalf ? 1 : 0);
      }),
    keyOffset
  );
  const scale = mode === 'minor' ? MINOR_SCALE : SCALE_INTERVALS;
  const triads = mode === 'minor' ? MINOR_TRIADS : MAJOR_TRIADS;

  // 把每个音归进所属小节，并转成"相对调式音级"投票。
  const bars = Array.from({ length: barCount }, () => ({
    votes: new Map(),
    notes: [],
    startBeat: 0,
    endBeat: 0,
  }));
  for (const event of noteEvents) {
    const n = event.note;
    if (!n || n.scale <= 0) continue;
    const barIndex = Math.min(barCount - 1, Math.max(0, Number(n.barIndex) || Math.floor(event.startBeat / barLength)));
    const bar = bars[barIndex];
    if (!bar.notes.length) bar.startBeat = event.startBeat;
    bar.endBeat = Math.max(bar.endBeat, event.startBeat + event.durationBeats);
    bar.notes.push(event);

    const pc = ((SCALE_INTERVALS[n.scale - 1] + (n.isHalf ? 1 : 0)) % 12 + 12) % 12;
    // 找到这个音最接近的调式音级
    let bestDegree = 1;
    let bestDist = 99;
    for (let d = 1; d <= 7; d += 1) {
      const dist = Math.min(
        Math.abs(pc - scale[d - 1]),
        Math.abs(pc - scale[d - 1] - 12),
        Math.abs(pc - scale[d - 1] + 12)
      );
      if (dist < bestDist) {
        bestDist = dist;
        bestDegree = d;
      }
    }
    const weight = bestDist <= 1 ? (bestDist === 0 ? 1 : 0.4) : 0.12;
    bar.votes.set(bestDegree, (bar.votes.get(bestDegree) || 0) + weight);
  }

  const out = [];
  const chordNames = [];
  let previousIndex = 0;
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    if (!bar.notes.length) {
      chordNames.push('—');
      continue;
    }
    let best = triads[0];
    let bestScore = -Infinity;
    for (const triad of triads) {
      let score = 0;
      for (const degree of triad.degrees) score += bar.votes.get(degree) || 0;
      // 偏好 I / IV / V 这类稳定功能，并轻微偏好与上一小节不同的和弦，避免呆板。
      if (['I', 'i', 'IV', 'iv', 'V'].includes(triad.name)) score += 0.25;
      if (triad.degree === previousIndex) score -= 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = triad;
      }
    }
    previousIndex = best.degree;
    chordNames.push(best.name);

    const startBeat = bar.startBeat;
    const endBeat = Math.max(bar.endBeat, startBeat + barLength * 0.85);
    const durationBeats = Math.max(0.5, endBeat - startBeat);

    // 和弦主体放在 C3 附近，低音在其下方八度。
    const chordTop = 48 + keyOffset;
    const chordMidis = triadMidis(best, tonicMidi, scale, chordTop);
    const bassMidi = chordTop - 12 + scale[best.degree - 1];

    out.push({
      startBeat,
      durationBeats,
      chordMidis,
      bassMidi,
      name: best.name,
      quality: best.quality,
      barIndex: i,
    });
  }

  return {
    events: out,
    key: meta.key || 'C',
    mode,
    barCount,
    chords: chordNames,
  };
}
