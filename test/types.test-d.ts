/**
 * 型レベルのテスト。`npm run typecheck` が通ること自体がテスト。
 * `@ts-expect-error` の行が型エラーにならなくなった場合、tsc が失敗する。
 */
import type {
  BetRecord,
  ClientSeed,
  Cursor,
  FixedArray,
  GameDefinition,
  GameOutcome,
  Nonce,
  NonNegativeInt,
  NonNegativeIntegerLiteral,
  PositiveInt,
  PositiveIntegerLiteral,
  ProvablyFairEngine,
  PublicSeedPair,
  SecretSeedPair,
  ServerSeed,
  ServerSeedHash,
  UnitFloat,
  VerificationResult,
} from '../src/index.js';

declare const engine: ProvablyFairEngine;
declare const seed: ServerSeed;
declare const hash: ServerSeedHash;
declare const client: ClientSeed;
declare const nonce: Nonce;
declare const secret: SecretSeedPair;
declare const f: UnitFloat;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(): T => true as T;

// ── ブランド: 生の値やブランド違いは代入できない
// @ts-expect-error 生の string は ServerSeed ではない
const s1: ServerSeed = 'a'.repeat(64);
// @ts-expect-error ServerSeedHash と ServerSeed は取り違えられない
const s2: ServerSeed = hash;
// @ts-expect-error 生の number は Nonce ではない
const n1: Nonce = 0;
// @ts-expect-error Nonce と UnitFloat は別物
const n2: Nonce = f;
// ブランド型は元の型としては使える
const asString: string = seed;

// ── 秘密の分離: SecretSeedPair を公開用に流用できない
// @ts-expect-error serverSeed を持つ値は PublicSeedPair に代入できない
const leaked: PublicSeedPair = secret;
const pub: PublicSeedPair = { status: 'active', serverSeedHash: hash, clientSeed: client, nonce };

// ── FixedArray: 長さが型で固定される
const three: FixedArray<UnitFloat, 3> = [f, f, f];
// @ts-expect-error 長さ不足
const two: FixedArray<UnitFloat, 3> = [f, f];
// @ts-expect-error 読み取り専用
three[0] = f;
assertType<Equal<FixedArray<UnitFloat, number>, never>>();
const fromEngine = engine.generateFloats({ serverSeed: seed, clientSeed: client, nonce }, 2);
assertType<Equal<typeof fromEngine, readonly [UnitFloat, UnitFloat]>>();

// ── ゲーム定義: floatCount と resolve の引数長が一致しなければならない
const dice = {
  id: 'dice',
  floatCount: 1,
  parseParams: (raw: unknown) =>
    typeof raw === 'number' ? { ok: true, value: { target: raw } } : { ok: false, error: 'target must be number' },
  resolve: ([x]: readonly [UnitFloat], params: { readonly target: number }) => {
    const roll = Math.floor(x * 10001) / 100;
    return { roll, win: roll < params.target };
  },
} as const satisfies GameDefinition<'dice', { readonly target: number }, { roll: number; win: boolean }, 1>;

const badGame = {
  id: 'bad',
  floatCount: 2,
  parseParams: () => ({ ok: true, value: null }),
  // @ts-expect-error floatCount が 2 なのに resolve は 1 要素タプルを要求
  resolve: ([x]: readonly [UnitFloat]) => x,
} as const satisfies GameDefinition<'bad', null, number, 2>;

const played = engine.play(secret, dice, { target: 50 });
assertType<Equal<GameOutcome<typeof dice>, { roll: number; win: boolean }>>();
// @ts-expect-error パラメータの型が違う
engine.play(secret, dice, { target: '50' });

const record: BetRecord<typeof dice> = played.record;
declare const revealedPair: Parameters<ProvablyFairEngine['verify']>[0];
const verified: VerificationResult<typeof dice> = engine.verify(revealedPair, record, dice);
if (verified.ok) {
  const win: boolean = verified.value.win;
  void win;
} else if (verified.error.kind === 'OUTCOME_MISMATCH') {
  const r: number = verified.error.recorded.roll;
  void r;
}

void [s1, s2, n1, n2, asString, leaked, pub, two, badGame];

// ── 0 以上の数値の保護
declare const cursor: Cursor;
declare const pos: PositiveInt;
declare const anyNumber: number;

// 部分型関係: Nonce / Cursor / PositiveInt は NonNegativeInt として使えるが逆は不可、兄弟同士も不可
const nn1: NonNegativeInt = nonce;
const nn2: NonNegativeInt = cursor;
const nn3: NonNegativeInt = pos;
declare const nn: NonNegativeInt;
// @ts-expect-error NonNegativeInt は Nonce とは限らない
const n3: Nonce = nn;
// @ts-expect-error Cursor を Nonce に使えない
const n4: Nonce = cursor;
// @ts-expect-error 0 は PositiveInt ではない（生の数値自体が不可）
const p1: PositiveInt = 0;

// リテラル判定
assertType<Equal<NonNegativeIntegerLiteral<0>, 0>>();
assertType<Equal<NonNegativeIntegerLiteral<-0>, 0>>();
assertType<Equal<NonNegativeIntegerLiteral<42>, 42>>();
assertType<Equal<NonNegativeIntegerLiteral<9007199254740991>, 9007199254740991>>();
assertType<Equal<NonNegativeIntegerLiteral<-1>, never>>();
assertType<Equal<NonNegativeIntegerLiteral<1.5>, never>>();
assertType<Equal<NonNegativeIntegerLiteral<1e21>, never>>();
assertType<Equal<NonNegativeIntegerLiteral<number>, never>>();
assertType<Equal<NonNegativeIntegerLiteral<1 | -1>, 1>>();
assertType<Equal<PositiveIntegerLiteral<0>, never>>();
assertType<Equal<PositiveIntegerLiteral<1>, 1>>();

// 定数コンストラクタ
const okNonce: Nonce = engine.nonceOf(0);
const okCursor: Cursor = engine.cursorOf(3);
// @ts-expect-error 負数
engine.nonceOf(-1);
// @ts-expect-error 小数
engine.nonceOf(0.5);
// @ts-expect-error 広い number は判定不能なので parseNonce を使う
engine.nonceOf(anyNumber);
// @ts-expect-error 共用体に負数が混ざっている
engine.cursorOf(Math.random() > 0.5 ? 1 : -1);

// 乱数個数
// @ts-expect-error 0 個は不可
engine.generateFloats({ serverSeed: seed, clientSeed: client, nonce }, 0);
// @ts-expect-error 負数
engine.generateFloats({ serverSeed: seed, clientSeed: client, nonce }, -1);
// @ts-expect-error 小数
engine.generateFloats({ serverSeed: seed, clientSeed: client, nonce }, 1.5);
// @ts-expect-error 広い number
engine.generateFloats({ serverSeed: seed, clientSeed: client, nonce }, anyNumber);
assertType<Equal<FixedArray<UnitFloat, -1>, never>>();
assertType<Equal<FixedArray<UnitFloat, 1.5>, never>>();

// floatCount
const zeroGame = {
  id: 'zero',
  // @ts-expect-error floatCount 0 は不可
  floatCount: 0,
  parseParams: () => ({ ok: true, value: null }),
  resolve: () => 0,
} as const satisfies GameDefinition<'zero', null, number, 0>;
const negGame = {
  id: 'neg',
  // @ts-expect-error floatCount 負数は不可
  floatCount: -1,
  parseParams: () => ({ ok: true, value: null }),
  resolve: () => 0,
} as const satisfies GameDefinition<'neg', null, number, -1>;

void [nn1, nn2, nn3, n3, n4, p1, okNonce, okCursor, zeroGame, negGame];

// GameDefinition を経由しないゲームでも、エンジンは floatCount を検査する
declare const rawBad: { id: 'raw'; floatCount: -2; parseParams: (raw: unknown) => { ok: true; value: null }; resolve: () => 0 };
declare const rawWide: { id: 'wide'; floatCount: number; parseParams: (raw: unknown) => { ok: true; value: null }; resolve: () => 0 };
// @ts-expect-error floatCount が負数
engine.play(secret, rawBad, null);
// @ts-expect-error floatCount が広い number
engine.play(secret, rawWide, null);
