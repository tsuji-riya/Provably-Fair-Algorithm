import type { GameDefinition, Result, UnitFloat } from '../types.js';

// JsonValue 制約を満たすため interface ではなく type（interface は暗黙のインデックスシグネチャを持たない）。
export type DiceParams = {
  /** この値未満の出目で勝ち。2〜98 の整数。 */
  readonly target: number;
};

export type DiceOutcome = {
  /** 0.00〜100.00 の出目（小数第 2 位まで）。 */
  readonly roll: number;
  readonly win: boolean;
};

const TARGET_MIN = 2;
const TARGET_MAX = 98;

/** ダイス: roll = floor(float * 10001) / 100（0.00〜100.00 の 10001 通り）。 */
export const dice = {
  id: 'dice',
  floatCount: 1,
  parseParams: (raw: unknown): Result<DiceParams, string> => {
    if (typeof raw !== 'object' || raw === null || !('target' in raw)) return { ok: false, error: 'target is required' };
    const { target } = raw;
    return typeof target === 'number' && Number.isInteger(target) && target >= TARGET_MIN && target <= TARGET_MAX
      ? { ok: true, value: { target } }
      : { ok: false, error: `target must be an integer between ${TARGET_MIN} and ${TARGET_MAX}` };
  },
  resolve: ([x]: readonly [UnitFloat], { target }: DiceParams): DiceOutcome => {
    const roll = Math.floor(x * 10001) / 100;
    return { roll, win: roll < target };
  },
} as const satisfies GameDefinition<'dice', DiceParams, DiceOutcome, 1>;
