/**
 * 出目の分布を集計する。シードは固定なので何度実行しても同じ結果になる。
 * 実行: npm run distribution
 *
 * 1. 1 組のシードで N 回振り、10 区間・100 区間のカイ二乗値、勝率、隣り合う出目の相関を出す。
 * 2. 別々のシード TRIALS 組で各 PER_TRIAL 回振り、10 区間のカイ二乗値が棄却域に入る割合を出す。
 *    乱数が一様なら 5% 水準で約 5%、1% 水準で約 1% になるはず。
 */
import { createHash } from 'node:crypto';
import { dice, engine } from '../src/index.js';
import type { Result, ServerSeed } from '../src/index.js';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const N = 10_000_000;
const TRIALS = 1_000;
const PER_TRIAL = 10_000;
// カイ二乗分布の上側臨界値（自由度 9 と 99）
const CRIT_DF9 = { p05: 16.919, p01: 21.666 };
const CRIT_DF99_P05 = 123.225;

const client = unwrap(engine.parseClientSeed('distribution'));
// 固定シード: ラベルの SHA-256（小文字 16 進 64 桁）を ServerSeed として使う。
const seedFrom = (label: string): ServerSeed =>
  unwrap(engine.parseServerSeed(createHash('sha256').update(label).digest('hex')));

const roll = (n: number, seed: ServerSeed, onRoll: (roll: number, win: boolean) => void): void => {
  let pair = engine.createSeedPair(seed, client);
  for (let i = 0; i < n; i++) {
    const { pair: next, record } = engine.play(pair, dice, { target: 50 });
    pair = next;
    onRoll(record.outcome.roll, record.outcome.win);
  }
};

const histogram = (bins: number) => {
  const counts: number[] = Array.from({ length: bins }, () => 0);
  return {
    counts,
    // 100.00 は最後の区間に入れる
    add: (r: number) => {
      const i = Math.min(bins - 1, Math.floor(r / (100 / bins)));
      counts[i] = (counts[i] ?? 0) + 1;
    },
    chiSquare: () => {
      const total = counts.reduce((s, c) => s + c, 0);
      const expected = total / bins;
      return counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    },
  };
};

// ── 1. 1 組のシードで N 回
const h10 = histogram(10);
const h100 = histogram(100);
let wins = 0;
let prev = Number.NaN;
let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, pairs = 0;
roll(N, seedFrom('single'), (r, win) => {
  h10.add(r);
  h100.add(r);
  if (win) wins++;
  if (!Number.isNaN(prev)) {
    sumX += prev; sumY += r; sumXY += prev * r; sumX2 += prev * prev; sumY2 += r * r; pairs++;
  }
  prev = r;
});
const lag1 =
  (pairs * sumXY - sumX * sumY) / Math.sqrt((pairs * sumX2 - sumX ** 2) * (pairs * sumY2 - sumY ** 2));
const p = 5000 / 10001; // target 50 で勝つ確率（0.00〜49.99 の 5000 通り）
const winRate = wins / N;

// ── 2. 別々のシードで繰り返す
const chis: number[] = [];
for (let t = 0; t < TRIALS; t++) {
  const h = histogram(10);
  roll(PER_TRIAL, seedFrom(`trial-${t}`), (r) => h.add(r));
  chis.push(h.chiSquare());
}
const over = (c: number) => chis.filter((x) => x > c).length / TRIALS;

const round = (x: number, d: number) => Number(x.toFixed(d));
console.log(
  JSON.stringify(
    {
      single: {
        n: N,
        counts10: h10.counts,
        chiSquare10: round(h10.chiSquare(), 2),
        chiSquare100: round(h100.chiSquare(), 2),
        chiSquare100Rejected05: h100.chiSquare() > CRIT_DF99_P05,
        winRate: round(winRate, 6),
        winRateExpected: round(p, 6),
        winRateStdError: round(Math.sqrt((p * (1 - p)) / N), 6),
        lag1Correlation: round(lag1, 6),
        lag1StdError: round(1 / Math.sqrt(pairs), 6),
      },
      repeated: {
        trials: TRIALS,
        perTrial: PER_TRIAL,
        meanChiSquare10: round(chis.reduce((s, x) => s + x, 0) / TRIALS, 3),
        rejectedAt05: over(CRIT_DF9.p05),
        rejectedAt01: over(CRIT_DF9.p01),
      },
    },
    null,
    2,
  ),
);
