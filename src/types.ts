/**
 * Provably Fair — 型定義
 *
 * 方式（HMAC-SHA256 によるコミット・リビール方式）:
 *   1. サーバーは ServerSeed を生成し、その SHA-256 ハッシュ（ServerSeedHash）だけを事前公開する（コミット）。
 *   2. プレイヤーは ClientSeed を指定する。ベットごとに Nonce が 1 ずつ増える。
 *   3. 乱数 = HMAC-SHA256(key = ServerSeed, message = `${ClientSeed}:${Nonce}:${Cursor}`)。
 *      1 ダイジェスト（32 バイト）から 4 バイトずつ 8 個の UnitFloat を取り出し、足りなければ Cursor を +1 する。
 *      float = b0/256 + b1/256^2 + b2/256^3 + b3/256^4  （値域 [0, 1)、分解能 2^-32）
 *   4. シードペアのローテーション時に ServerSeed を公開（リビール）し、
 *      プレイヤーは SHA-256(ServerSeed) === ServerSeedHash と全ベットの結果を再計算して検証できる。
 *
 * エンコーディング規約: ServerSeed は 64 桁の小文字 16 進文字列で、HMAC 鍵およびハッシュ入力には
 * その ASCII 文字列そのものを使う（既存の第三者検証ツールと互換にするため）。
 *
 * 型設計の方針: 検証済みの値はブランド型でしか表現できず、ブランド型はパーサ（Result を返す）
 * からしか得られない。秘密（ServerSeed）を含む型と公開用の型を構造的に分離し、取り違えを型エラーにする。
 */

// ───────────────────────────── 基本ユーティリティ ─────────────────────────────

declare const brandSymbol: unique symbol;

/**
 * 名目的型付け。`T` と構造的に同じでも、パーサを通さない値は代入できない。
 * ブランドはキー集合として持つので、`Brand<Brand<number, 'A'>, 'B'>` は A と B の両方を満たす（部分型関係を表せる）。
 */
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: { readonly [K in B]: true } };

/** 例外を使わない失敗表現。`ok` で判別する。 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

// ───────────────────────────── 数値リテラルの型レベル検査 ─────────────────────────────

/**
 * N が 0 以上の整数リテラルなら N、そうでなければ never。
 * 判定は数値リテラルの文字列表現で行う: 負号・小数点・指数表記（1e21 以上や 1e-7 未満）・NaN・Infinity を拒否する。
 * 共用体は要素ごとに判定するので `1 | -1` は `1` に絞られ、引数として渡すと型エラーになる。
 * 広い `number` は判定不能なので never（実行時の値はパーサを通すこと）。
 */
export type NonNegativeIntegerLiteral<N extends number> = number extends N
  ? never
  : N extends number
    ? `${N}` extends `-${string}` | `${string}.${string}` | `${string}e${string}` | 'NaN' | 'Infinity'
      ? never
      : N
    : never;

/** N が 1 以上の整数リテラルなら N、そうでなければ never。 */
export type PositiveIntegerLiteral<N extends number> = Exclude<NonNegativeIntegerLiteral<N>, 0>;

/**
 * 長さ N の読み取り専用タプル。N は 0 以上の整数リテラルでなければならない（それ以外は never）。
 * shortcut: 再帰型のため N が約 1000 を超えるとコンパイラの再帰上限に当たる。カードゲーム（52）程度までを想定。
 */
export type FixedArray<T, N extends number> = [NonNegativeIntegerLiteral<N>] extends [never]
  ? never
  : BuildTuple<T, N, readonly []>;
type BuildTuple<T, N extends number, Acc extends readonly T[]> = Acc['length'] extends N
  ? Acc
  : BuildTuple<T, N, readonly [...Acc, T]>;

/** 検証時に結果を正規化して比較できるよう、ゲーム結果は JSON 値に限定する。 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// ───────────────────────────── ブランド型（検証済みの値） ─────────────────────────────

/** 32 バイトの暗号論的乱数を 64 桁の小文字 16 進で表したもの。秘密情報。 */
export type ServerSeed = Brand<string, 'ServerSeed'>;

/** SHA-256(ServerSeed) の 64 桁小文字 16 進。事前公開するコミットメント。 */
export type ServerSeedHash = Brand<string, 'ServerSeedHash'>;

/**
 * プレイヤー指定のシード。1〜64 文字の表示可能 ASCII（0x21–0x7E）で ':' を含まない。
 * ':' を禁止するのは、HMAC メッセージ `${clientSeed}:${nonce}:${cursor}` の区切りを一意に保つため。
 */
export type ClientSeed = Brand<string, 'ClientSeed'>;

/** 0 以上 Number.MAX_SAFE_INTEGER 以下の整数。Nonce・Cursor・PositiveInt の上位型。 */
export type NonNegativeInt = Brand<number, 'NonNegativeInt'>;

/** 1 以上 Number.MAX_SAFE_INTEGER 以下の整数（乱数の要求個数など）。NonNegativeInt の部分型。 */
export type PositiveInt = Brand<NonNegativeInt, 'PositiveInt'>;

/** ベット番号。NonNegativeInt の部分型。 */
export type Nonce = Brand<NonNegativeInt, 'Nonce'>;

/** 同一ベット内での HMAC ブロック番号。NonNegativeInt の部分型。 */
export type Cursor = Brand<NonNegativeInt, 'Cursor'>;

/** [0, 1) の一様乱数。分解能 2^-32。 */
export type UnitFloat = Brand<number, 'UnitFloat'>;

/** HMAC-SHA256 の出力（32 バイト）。 */
export type HmacDigest = Brand<Readonly<Uint8Array>, 'HmacDigest'>;

// ───────────────────────────── パースエラー ─────────────────────────────

export type ParseError =
  | { readonly kind: 'NOT_HEX_64'; readonly field: 'serverSeed' | 'serverSeedHash'; readonly input: string }
  | { readonly kind: 'CLIENT_SEED_LENGTH'; readonly length: NonNegativeInt; readonly min: 1; readonly max: 64 }
  | { readonly kind: 'CLIENT_SEED_INVALID_CHAR'; readonly index: NonNegativeInt; readonly char: string }
  | { readonly kind: 'NOT_SAFE_NON_NEGATIVE_INT'; readonly field: 'nonce' | 'cursor'; readonly input: number }
  | { readonly kind: 'NOT_POSITIVE_INT'; readonly input: number };

// ───────────────────────────── シードペアのライフサイクル ─────────────────────────────

/**
 * サーバー内部だけで保持するアクティブなシードペア。ServerSeed を含むため外部に出してはならない。
 * `nonce` は「次のベットで使う」番号。
 */
export interface SecretSeedPair {
  readonly status: 'active';
  readonly serverSeed: ServerSeed;
  readonly serverSeedHash: ServerSeedHash;
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
}

/** プレイヤーに公開するアクティブなシードペア。`serverSeed` を持つことは型レベルで禁止。 */
export interface PublicSeedPair {
  readonly status: 'active';
  readonly serverSeed?: never;
  readonly serverSeedHash: ServerSeedHash;
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
}

/**
 * ローテーション後に公開されるシードペア。
 * `nextNonce` は使用されなかった最初の番号で、検証対象のベットは 0 <= nonce < nextNonce に限られる。
 */
export interface RevealedSeedPair {
  readonly status: 'revealed';
  readonly serverSeed: ServerSeed;
  readonly serverSeedHash: ServerSeedHash;
  readonly clientSeed: ClientSeed;
  readonly nextNonce: Nonce;
}

export type SeedPair = SecretSeedPair | PublicSeedPair | RevealedSeedPair;

/** ローテーションの結果。旧ペアは公開され、新ペアは nonce 0 から始まる。 */
export interface RotationResult {
  readonly revealed: RevealedSeedPair;
  readonly next: SecretSeedPair;
}

// ───────────────────────────── 乱数生成 ─────────────────────────────

/** HMAC 1 回分の入力。 */
export interface HmacInput {
  readonly serverSeed: ServerSeed;
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
  readonly cursor: Cursor;
}

// ───────────────────────────── ゲーム定義 ─────────────────────────────

/**
 * ゲームは「UnitFloat の固定長タプル + パラメータ → 結果」の純粋関数として定義する。
 * 同じ入力からは常に同じ結果が出なければならない（検証の前提）。
 * shortcut: 必要な乱数個数は N 固定。パラメータで個数が変わるゲーム（行数可変の Plinko 等）が必要になったら
 *           floatCount を Params の関数に拡張する。
 */
export interface GameDefinition<
  Id extends string,
  Params extends JsonValue,
  Outcome extends JsonValue,
  N extends number,
> {
  readonly id: Id;
  /** 1 以上の整数リテラル。それ以外（0・負数・小数・`number`）を指定すると never になり定義できない。 */
  readonly floatCount: PositiveIntegerLiteral<N>;
  readonly parseParams: (raw: unknown) => Result<Params, string>;
  readonly resolve: (floats: FixedArray<UnitFloat, N>, params: Params) => Outcome;
}

/**
 * 任意のゲーム定義（ジェネリック関数の制約用）。
 * resolve の引数は反変なので、任意のゲームを受けるには any が必要。
 * floatCount はここでは number だが、エンジンは引数を ValidGame<G> で受けるため不正な値は型エラーになる。
 */
export interface AnyGame {
  readonly id: string;
  readonly floatCount: number;
  readonly parseParams: (raw: unknown) => Result<any, string>;
  readonly resolve: (floats: any, params: any) => JsonValue;
}

/** floatCount が 1 以上の整数リテラルであるゲームだけを通す。 */
export type ValidGame<G extends AnyGame> = G & { readonly floatCount: PositiveIntegerLiteral<G['floatCount']> };

export type GameId<G extends AnyGame> = G['id'];
export type GameParams<G extends AnyGame> = Parameters<G['resolve']>[1];
export type GameOutcome<G extends AnyGame> = ReturnType<G['resolve']>;

// ───────────────────────────── ベット記録と検証 ─────────────────────────────

/** 1 回のベットの公開記録。どのコミットメントの下で行われたかを serverSeedHash で紐付ける。 */
export interface BetRecord<G extends AnyGame> {
  readonly gameId: GameId<G>;
  readonly serverSeedHash: ServerSeedHash;
  readonly clientSeed: ClientSeed;
  readonly nonce: Nonce;
  readonly params: GameParams<G>;
  readonly outcome: GameOutcome<G>;
}

export interface PlayResult<G extends AnyGame> {
  /** nonce を 1 進めたシードペア。 */
  readonly pair: SecretSeedPair;
  readonly record: BetRecord<G>;
}

export type VerificationFailure<G extends AnyGame> =
  /** サーバーから受け取ったデータが形式を満たさない（型は実行時には保証されないため検査し直す）。 */
  | { readonly kind: 'MALFORMED_INPUT'; readonly field: string; readonly reason: string }
  | { readonly kind: 'HASH_MISMATCH'; readonly committed: ServerSeedHash; readonly computed: ServerSeedHash }
  | { readonly kind: 'SEED_PAIR_MISMATCH'; readonly field: 'serverSeedHash' | 'clientSeed' }
  | { readonly kind: 'GAME_MISMATCH'; readonly expected: GameId<G>; readonly actual: string }
  | { readonly kind: 'NONCE_NOT_USED'; readonly nonce: Nonce; readonly nextNonce: Nonce }
  | { readonly kind: 'OUTCOME_MISMATCH'; readonly recorded: GameOutcome<G>; readonly computed: GameOutcome<G> };

export type VerificationResult<G extends AnyGame> = Result<GameOutcome<G>, VerificationFailure<G>>;

// ───────────────────────────── エンジンの契約 ─────────────────────────────

/**
 * 実装が満たすべきインターフェース。実装側は `satisfies ProvablyFairEngine` で適合を保証する。
 * Node の node:crypto（同期 API）を前提とする。
 */
export interface ProvablyFairEngine {
  readonly parseServerSeed: (raw: string) => Result<ServerSeed, ParseError>;
  readonly parseServerSeedHash: (raw: string) => Result<ServerSeedHash, ParseError>;
  readonly parseClientSeed: (raw: string) => Result<ClientSeed, ParseError>;
  readonly parseNonce: (raw: number) => Result<Nonce, ParseError>;
  readonly parseCursor: (raw: number) => Result<Cursor, ParseError>;
  /**
   * コード中の定数用。0 以上の整数リテラルだけを受け付けるので失敗しない（負数・小数・`number` は型エラー）。
   * 実行時に得た値は parseNonce / parseCursor を使う。
   */
  readonly nonceOf: <const N extends number>(n: N & NonNegativeIntegerLiteral<N>) => Nonce;
  readonly cursorOf: <const N extends number>(n: N & NonNegativeIntegerLiteral<N>) => Cursor;

  /** CSPRNG で 32 バイトを生成する。 */
  readonly generateServerSeed: () => ServerSeed;
  readonly hashServerSeed: (serverSeed: ServerSeed) => ServerSeedHash;

  readonly hmac: (input: HmacInput) => HmacDigest;
  /** cursor 0 から必要なだけ HMAC を計算し、先頭から N 個の UnitFloat を返す。 */
  readonly generateFloats: <const N extends number>(
    input: Omit<HmacInput, 'cursor'>,
    count: N & PositiveIntegerLiteral<N>,
  ) => FixedArray<UnitFloat, N>;

  readonly createSeedPair: (serverSeed: ServerSeed, clientSeed: ClientSeed) => SecretSeedPair;
  readonly toPublic: (pair: SecretSeedPair) => PublicSeedPair;
  readonly play: <G extends AnyGame>(pair: SecretSeedPair, game: ValidGame<G>, params: GameParams<G>) => PlayResult<G>;
  readonly rotate: (
    pair: SecretSeedPair,
    nextServerSeed: ServerSeed,
    nextClientSeed: ClientSeed,
  ) => RotationResult;

  /** プレイヤー側の検証。サーバーの秘密には依存しない。 */
  readonly verify: <G extends AnyGame>(
    revealed: RevealedSeedPair,
    record: BetRecord<G>,
    game: ValidGame<G>,
  ) => VerificationResult<G>;
}
