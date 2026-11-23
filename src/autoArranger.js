/**
 * FloatNote · 流派自动编配
 * 只做本地规则分析：音域跨度、节奏密度、速度、五声性、乐器音域与音色区分。
 */

import {
  INSTRUMENTS,
  INSTRUMENT_ORDER,
  fitMidiToRange,
  instrumentRangeWidth,
} from './instruments.js';
import { midiToName } from './tools.js';
import { noteToMidi } from './scoreParser.js';

export const GENRE_PROFILES = Object.freeze({
  古典: {
    bpm: [60, 100],
    family: 'bowed',
    description: '宽音域、中等偏高的节奏密度，速度从容，适合完整旋律与和声展开。',
  },
  民乐: {
    bpm: [60, 140],
    family: 'wind',
    description: '音域偏窄、句法灵活，五声音阶占主导，适合有呼吸感的旋律。',
  },
  通俗: {
    bpm: [80, 160],
    family: 'keyboard',
    description: '音域适中、节奏密度高，速度弹性大，强调清晰的律动与旋律记忆点。',
  },
});

const FAMILY_LABELS = Object.freeze({
  keyboard: '键盘类',
  pluck: '拨弦类',
  bowed: '弓弦类',
  reed: '簧管类',
  wind: '气鸣类',
});

export const FAMILY_LABEL_LIST = FAMILY_LABELS;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

function uniqueDegrees(notes) {
  return new Set(notes.filter((n) => n.scale > 0).map((n) => n.scale));
}

function computeAnalysis(parsed) {
  const notes = parsed.notes || [];
  const meta = parsed.meta || {};
  const sounding = notes.filter((n) => n.scale > 0);
  const midis = sounding.map((n) => noteToMidi(n, meta.keyOffset)).filter((n) => n !== null);
  if (!midis.length) return null;

  const totalBeats = notes.reduce((sum, n) => sum + n.duration, 0);
  const bars = notes.length ? Math.max(...notes.map((n) => n.barIndex)) + 1 : 0;
  const minMidi = Math.min(...midis);
  const maxMidi = Math.max(...midis);
  const density = totalBeats > 0 ? sounding.length / totalBeats : 0;
  const degrees = uniqueDegrees(notes);
  const pentatonicHits = sounding.filter((n) => [1, 2, 3, 5, 6].includes(n.scale) && !n.isHalf).length;
  const pentatonicRatio = sounding.length ? pentatonicHits / sounding.length : 0;
  const accidentalRatio = sounding.length
    ? sounding.filter((n) => n.isHalf).length / sounding.length
    : 0;

  return {
    key: meta.key || 'C',
    timeSig: meta.timeSig || '4/4',
    bpm: Number(meta.bpm) || 80,
    noteCount: sounding.length,
    bars,
    totalBeats,
    density,
    minMidi,
    maxMidi,
    midis,
    span: maxMidi - minMidi,
    averageMidi: midis.reduce((a, b) => a + b, 0) / midis.length,
    degrees,
    pentatonicRatio,
    accidentalRatio,
    rangeText: `${midiToName(minMidi)} – ${midiToName(maxMidi)}`,
  };
}

function scoreGenres(analysis) {
  const { bpm, density, span, pentatonicRatio } = analysis;
  const scores = { 古典: 0, 民乐: 0, 通俗: 0 };
  const details = { 古典: [], 民乐: [], 通俗: [] };

  // 古典：宽音域、密度中等偏高、速度 60–100、非五声倾向。
  if (bpm >= 60 && bpm <= 100) {
    scores.古典 += 2;
    details.古典.push('速度落在古典常见的 60–100 BPM');
  } else if (bpm >= 50 && bpm <= 115) {
    scores.古典 += 1;
    details.古典.push('速度接近古典常用的从容区间');
  }
  if (span >= 18) {
    scores.古典 += 2;
    details.古典.push(`旋律跨度 ${span} 个半音，音域开阔`);
  } else if (span >= 14) {
    scores.古典 += 1;
    details.古典.push('旋律有一定跨度，适合完整句法');
  }
  if (density >= 0.45 && density <= 1.4) {
    scores.古典 += 1;
    details.古典.push('节奏密度适中');
  }
  if (pentatonicRatio < 0.82) {
    scores.古典 += 1;
    details.古典.push('音级使用较丰富，不完全依赖五声音阶');
  }

  // 民乐：窄音域、五声性强、速度灵活。
  if (pentatonicRatio >= 0.82) {
    scores.民乐 += 3;
    details.民乐.push(`五声音级占比 ${Math.round(pentatonicRatio * 100)}%`);
  } else if (pentatonicRatio >= 0.65) {
    scores.民乐 += 1.5;
    details.民乐.push('五声音级占比较高');
  }
  if (span <= 16) {
    scores.民乐 += 2;
    details.民乐.push(`旋律跨度 ${span} 个半音，音域较集中`);
  } else if (span <= 20) {
    scores.民乐 += 1;
    details.民乐.push('音域跨度适中');
  }
  if (bpm >= 60 && bpm <= 140) {
    scores.民乐 += 1;
    details.民乐.push('速度落在民乐常见的弹性区间');
  }

  // 通俗：密度高、速度 80–160、音域适中。
  if (bpm >= 80 && bpm <= 160) {
    scores.通俗 += 2;
    details.通俗.push('速度落在通俗歌曲的常见区间');
  } else if (bpm >= 70 && bpm <= 170) {
    scores.通俗 += 1;
    details.通俗.push('速度接近通俗歌曲的弹性范围');
  }
  if (density >= 0.8) {
    scores.通俗 += 2;
    details.通俗.push(`每拍约 ${round(density, 2)} 个音，律动较密`);
  } else if (density >= 0.55) {
    scores.通俗 += 1;
    details.通俗.push('节奏密度中等偏高');
  }
  if (span >= 10 && span <= 24) {
    scores.通俗 += 1;
    details.通俗.push('音域跨度适合人声化旋律');
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const genre = ranked[0][0];
  const best = ranked[0][1];
  const second = ranked[1][1];
  const confidence = clamp(0.58 + (best - second) * 0.035 + best * 0.018, 0.58, 0.97);
  return {
    genre,
    scores,
    details: details[genre],
    confidence,
    summary: `全曲跨度 ${analysis.span} 个半音，每拍约 ${round(analysis.density, 2)} 个音，原谱速度 ${analysis.bpm} BPM。${details[genre].slice(0, 2).join('，')}，因此更接近「${genre}」。`,
  };
}

function evaluateInstrument(instrument, analysis, genre) {
  let coverage = 0;
  let totalShift = 0;
  let sameRegister = 0;
  for (const midi of analysis.midis || []) {
    const fit = fitMidiToRange(midi, instrument.minMidi, instrument.maxMidi);
    if (fit.midi !== null) coverage += 1;
    totalShift += Math.abs(fit.octaves);
  }
  // analysis.midis 不对外暴露，这里用音域范围近似覆盖情况。
  const midiSpan = analysis.span;
  const width = instrumentRangeWidth(instrument);
  const canCoverSpan = midiSpan <= width;
  const insideMean =
    analysis.averageMidi >= instrument.minMidi && analysis.averageMidi <= instrument.maxMidi;
  const affinity = Number(instrument.genreAffinity?.[genre] || 1);
  const rangeScore =
    (canCoverSpan ? 2.2 : 0.6) +
    (insideMean ? 1.1 : 0.4) +
    clamp(1 - Math.abs(analysis.averageMidi - (instrument.minMidi + instrument.maxMidi) / 2) / 48, 0, 1);
  const score = affinity * 2 + rangeScore + (canCoverSpan ? 0.8 : 0);
  return {
    score,
    affinity,
    canCoverSpan,
    insideMean,
    rangeScore,
    coverage,
    totalShift,
  };
}

function instrumentReason(instrument, evaluation, genre) {
  const affinityText =
    evaluation.affinity >= 3 ? '与这一流派的听感非常契合' : evaluation.affinity >= 2 ? '与这一流派的气质相符' : '可以提供不同的音色视角';
  const rangeText = evaluation.canCoverSpan
    ? `音域 ${instrument.rangeLabel} 能覆盖全曲跨度`
    : `音域 ${instrument.rangeLabel} 略窄，播放时会对少数越界音符做八度适配`;
  return `${instrument.name}属于${FAMILY_LABELS[instrument.family] || '乐器'}，${affinityText}；${rangeText}。`;
}

function pickAccompaniment(lead, analysis, genre) {
  const candidates = INSTRUMENT_ORDER.filter((id) => id !== lead.id).map((id) => {
    const instrument = INSTRUMENTS[id];
    const evaluation = evaluateInstrument(instrument, analysis, genre);
    const differentFamily = instrument.family !== lead.instrument.family ? 1.6 : 0;
    const lowerRegister = instrument.maxMidi < lead.instrument.maxMidi ? 0.4 : 0;
    const accompanimentBoost = instrument.family === 'pluck' || instrument.family === 'keyboard' ? 0.4 : 0;
    return {
      instrument,
      evaluation,
      score: evaluation.score + differentFamily + lowerRegister + accompanimentBoost,
      differentFamily,
    };
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const reason = `主奏选择${lead.instrument.name}后，${best.instrument.name}（${FAMILY_LABELS[best.instrument.family]}）在音色上更容易与之区分，适合铺一层轻伴奏或对位声部。`;
  return {
    id: best.instrument.id,
    name: best.instrument.name,
    score: round(best.score, 2),
    differentFamily: Boolean(best.differentFamily),
    reason,
  };
}

function tempoSuggestion(bpm, genre) {
  const [min, max] = GENRE_PROFILES[genre].bpm;
  let target = bpm;
  if (bpm < min) target = Math.min(min, bpm + 12);
  if (bpm > max) target = Math.max(max, bpm - 12);
  target = Math.round(clamp(target, 20, 300));
  if (target === bpm) {
    return {
      bpm: target,
      reason: `原谱 ${bpm} BPM 已经落在「${genre}」的常用速度区间 ${min}–${max} BPM 内，保持原速。`,
    };
  }
  return {
    bpm: target,
    reason: `原谱 ${bpm} BPM 更贴近「${genre}」时，小幅调整到 ${target} BPM（建议区间 ${min}–${max} BPM），不改变乐句重心。`,
  };
}

/**
 * @param {ReturnType<import('./scoreParser.js').parseScore>} parsed
 * @returns {object|null}
 */
export function arrangeScore(parsed) {
  if (!parsed || !parsed.ok || !parsed.notes || !parsed.notes.length) return null;
  const analysis = computeAnalysis(parsed);
  if (!analysis) return null;

  const genreInfo = scoreGenres(analysis);

  const ranked = INSTRUMENT_ORDER.map((id) => {
    const instrument = INSTRUMENTS[id];
    const evaluation = evaluateInstrument(instrument, analysis, genreInfo.genre);
    return { instrument, evaluation, score: evaluation.score };
  }).sort((a, b) => b.score - a.score);

  const lead = ranked[0];
  const leadConfidence = clamp(0.56 + (lead.score - ranked[1].score) * 0.025 + lead.evaluation.affinity * 0.04, 0.56, 0.97);

  const accompaniment = pickAccompaniment(
    { id: lead.instrument.id, instrument: lead.instrument },
    analysis,
    genreInfo.genre
  );

  const tempo = tempoSuggestion(analysis.bpm, genreInfo.genre);
  const reverbPreset = lead.instrument.reverb;
  const reverbLabel = lead.instrument.reverbLabel;
  const reverbReason =
    reverbPreset === 'long'
      ? `${lead.instrument.name}使用长混响，让尾音在空间中自然扩散，适合抒情、留白较多的乐句。`
      : `${lead.instrument.name}使用短混响，保持颗粒清晰和节奏轮廓，避免密集音符糊在一起。`;

  return {
    genre: genreInfo.genre,
    genreConfidence: genreInfo.confidence,
    genreReason: genreInfo.summary,
    genreDetails: genreInfo.details,
    scores: genreInfo.scores,
    stats: {
      key: analysis.key,
      timeSig: analysis.timeSig,
      bpm: analysis.bpm,
      bars: analysis.bars,
      noteCount: analysis.noteCount,
      density: round(analysis.density, 2),
      span: analysis.span,
      rangeText: analysis.rangeText,
      pentatonicPercent: Math.round(analysis.pentatonicRatio * 100),
      accidentalPercent: Math.round(analysis.accidentalRatio * 100),
    },
    lead: {
      id: lead.instrument.id,
      name: lead.instrument.name,
      score: round(lead.score, 2),
      confidence: leadConfidence,
      reason: instrumentReason(lead.instrument, lead.evaluation, genreInfo.genre),
    },
    accompaniment,
    reverb: {
      preset: reverbPreset,
      label: reverbLabel,
      reason: reverbReason,
    },
    tempo: {
      bpm: tempo.bpm,
      reason: tempo.reason,
    },
    note:
      '以上只是规则推荐，不是固定答案。乐器、速度、混响、音量都可以在左侧继续手动调整。',
  };
}
