export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Estimate {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

export function bootstrapCI(xs: number[], { iterations = 2000, alpha = 0.05, seed = 1 } = {}): Estimate {
  if (!xs.length) return { mean: NaN, lo: NaN, hi: NaN, n: 0 };
  const rand = rng(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) sum += xs[Math.floor(rand() * xs.length)];
    means.push(sum / xs.length);
  }
  return { mean: mean(xs), lo: percentile(means, (alpha / 2) * 100), hi: percentile(means, (1 - alpha / 2) * 100), n: xs.length };
}

export function brierScore(preds: Array<{ p: number; y: boolean }>): number {
  return mean(preds.map(({ p, y }) => (p - (y ? 1 : 0)) ** 2));
}

export function expectedCalibrationError(preds: Array<{ p: number; y: boolean }>, bins = 5): number {
  if (!preds.length) return NaN;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = preds.filter(({ p }) => (b === bins - 1 ? p >= lo && p <= hi : p >= lo && p < hi));
    if (!inBin.length) continue;
    const conf = mean(inBin.map((x) => x.p));
    const acc = mean(inBin.map((x) => (x.y ? 1 : 0)));
    ece += (inBin.length / preds.length) * Math.abs(acc - conf);
  }
  return ece;
}

export function cohenKappa(pairs: Array<[boolean, boolean]>): number {
  const n = pairs.length;
  if (!n) return NaN;
  const agree = pairs.filter(([a, b]) => a === b).length / n;
  const pa = pairs.filter(([a]) => a).length / n;
  const pb = pairs.filter(([, b]) => b).length / n;
  const expected = pa * pb + (1 - pa) * (1 - pb);
  return expected === 1 ? 1 : (agree - expected) / (1 - expected);
}

export function passHatK(trials: boolean[]): boolean {
  return trials.length > 0 && trials.every(Boolean);
}
