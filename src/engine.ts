import { createHash, createHmac, randomBytes } from 'node:crypto';
import type {
  AnyGame,
  BetRecord,
  ClientSeed,
  Cursor,
  GameOutcome,
  HmacDigest,
  HmacInput,
  JsonValue,
  Nonce,
  ParseError,
  PlayResult,
  ProvablyFairEngine,
  PublicSeedPair,
  Result,
  RevealedSeedPair,
  RotationResult,
  SecretSeedPair,
  ServerSeed,
  ServerSeedHash,
  UnitFloat,
  ValidGame,
  VerificationResult,
} from './types.js';

const HEX_64 = /^[0-9a-f]{64}$/;
const CLIENT_SEED_MIN = 1;
const CLIENT_SEED_MAX = 64;
const FLOATS_PER_DIGEST = 8; // 32 バイト / 4 バイト
const TWO_POW_32 = 2 ** 32;

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** 検証済みの値にブランドを付ける。このファイルの中でだけ、検証直後にのみ使う。 */
const unsafeBrand = <T>(value: unknown): T => value as T;

/** 失敗しない前提の箇所で Result を値に戻す。失敗したら実装のバグなので例外にする。 */
const expectOk = <T>(r: Result<T, ParseError>): T => {
  if (!r.ok) throw new Error(`invariant violated: ${JSON.stringify(r.error)}`);
  return r.value;
};

const parseHex64 =
  <T>(field: 'serverSeed' | 'serverSeedHash') =>
  (raw: string): Result<T, ParseError> =>
    HEX_64.test(raw) ? ok(unsafeBrand<T>(raw)) : err({ kind: 'NOT_HEX_64', field, input: raw });

const parseServerSeed = parseHex64<ServerSeed>('serverSeed');
const parseServerSeedHash = parseHex64<ServerSeedHash>('serverSeedHash');

const parseClientSeed = (raw: string): Result<ClientSeed, ParseError> => {
  if (raw.length < CLIENT_SEED_MIN || raw.length > CLIENT_SEED_MAX) {
    return err({
      kind: 'CLIENT_SEED_LENGTH',
      length: unsafeBrand(raw.length),
      min: CLIENT_SEED_MIN,
      max: CLIENT_SEED_MAX,
    });
  }
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // 表示可能 ASCII（0x21–0x7E）のみ。':' は HMAC メッセージの区切りなので禁止。
    if (code < 0x21 || code > 0x7e || code === 0x3a) {
      return err({ kind: 'CLIENT_SEED_INVALID_CHAR', index: unsafeBrand(i), char: raw.charAt(i) });
    }
  }
  return ok(unsafeBrand<ClientSeed>(raw));
};

const parseNonNegative =
  <T>(field: 'nonce' | 'cursor') =>
  (raw: number): Result<T, ParseError> =>
    // Number.isSafeInteger は NaN・Infinity・小数・範囲外を拒否する。-0 は 0 に正規化する。
    Number.isSafeInteger(raw) && raw >= 0
      ? ok(unsafeBrand<T>(raw === 0 ? 0 : raw))
      : err({ kind: 'NOT_SAFE_NON_NEGATIVE_INT', field, input: raw });

const parseNonce = parseNonNegative<Nonce>('nonce');
const parseCursor = parseNonNegative<Cursor>('cursor');

const hashServerSeed = (serverSeed: ServerSeed): ServerSeedHash =>
  unsafeBrand(createHash('sha256').update(serverSeed, 'ascii').digest('hex'));

const hmac = (input: HmacInput): HmacDigest =>
  unsafeBrand(
    createHmac('sha256', Buffer.from(input.serverSeed, 'ascii'))
      .update(`${input.clientSeed}:${input.nonce}:${input.cursor}`, 'ascii')
      .digest(),
  );

/** 型は count をリテラルに制限するが、`as` などで迂回された場合に備えて実行時にも検査する。 */
const generateFloatsUnchecked = (input: Omit<HmacInput, 'cursor'>, count: number): readonly UnitFloat[] => {
  if (!Number.isSafeInteger(count) || count < 1) throw new RangeError(`count must be a positive integer: ${count}`);
  const floats: UnitFloat[] = [];
  for (let cursor = 0; floats.length < count; cursor++) {
    const digest = Buffer.from(hmac({ ...input, cursor: expectOk(parseCursor(cursor)) }));
    for (let i = 0; i < FLOATS_PER_DIGEST && floats.length < count; i++) {
      // b0/256 + b1/256^2 + b2/256^3 + b3/256^4 と厳密に等しい（32 ビット整数 / 2^32 は倍精度で誤差なし）。
      floats.push(unsafeBrand<UnitFloat>(digest.readUInt32BE(i * 4) / TWO_POW_32));
    }
  }
  return floats;
};


const createSeedPair = (serverSeed: ServerSeed, clientSeed: ClientSeed): SecretSeedPair => ({
  status: 'active',
  serverSeed,
  serverSeedHash: hashServerSeed(serverSeed),
  clientSeed,
  nonce: expectOk(parseNonce(0)),
});

/** スプレッドを使わず明示的に組み立て、serverSeed が実行時にも混入しないようにする。 */
const toPublic = (pair: SecretSeedPair): PublicSeedPair => ({
  status: 'active',
  serverSeedHash: pair.serverSeedHash,
  clientSeed: pair.clientSeed,
  nonce: pair.nonce,
});

const resolveOutcome = <G extends AnyGame>(
  game: G,
  seeds: Omit<HmacInput, 'cursor'>,
  params: unknown,
): GameOutcome<G> => game.resolve(generateFloatsUnchecked(seeds, game.floatCount), params) as GameOutcome<G>;

const play = <G extends AnyGame>(pair: SecretSeedPair, game: ValidGame<G>, params: Parameters<G['resolve']>[1]): PlayResult<G> => {
  const next = parseNonce(pair.nonce + 1);
  // 2^53 回のベットは現実には起きないが、起きたら同じ nonce を再利用しないよう停止する。
  if (!next.ok) throw new RangeError('nonce exhausted: rotate the seed pair');
  const outcome = resolveOutcome(game, pair, params);
  return {
    pair: { ...pair, nonce: next.value },
    record: {
      gameId: game.id,
      serverSeedHash: pair.serverSeedHash,
      clientSeed: pair.clientSeed,
      nonce: pair.nonce,
      params,
      outcome,
    },
  };
};

const rotate = (pair: SecretSeedPair, nextServerSeed: ServerSeed, nextClientSeed: ClientSeed): RotationResult => {
  // 公開済みのシードを再利用すると、以後の結果がプレイヤーに予測可能になる。
  if (nextServerSeed === pair.serverSeed) throw new Error('next server seed must differ from the revealed one');
  return {
    revealed: {
      status: 'revealed',
      serverSeed: pair.serverSeed,
      serverSeedHash: pair.serverSeedHash,
      clientSeed: pair.clientSeed,
      nextNonce: pair.nonce,
    },
    next: createSeedPair(nextServerSeed, nextClientSeed),
  };
};

/** キー順に依存しない JSON 文字列。結果の同値比較に使う。 */
const canonicalJson = (value: JsonValue): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as JsonValue)}`)
    .join(',')}}`;
};

/**
 * プレイヤー側の検証。引数はサーバーから受け取った（＝信用できない）データなので、
 * 型が付いていても実行時に全フィールドを検査し直す。
 */
const verify = <G extends AnyGame>(
  revealed: RevealedSeedPair,
  record: BetRecord<G>,
  game: ValidGame<G>,
): VerificationResult<G> => {
  const malformed = (field: string, reason: string): VerificationResult<G> =>
    err({ kind: 'MALFORMED_INPUT', field, reason });

  const serverSeed = parseServerSeed(revealed.serverSeed);
  if (!serverSeed.ok) return malformed('revealed.serverSeed', serverSeed.error.kind);
  const committed = parseServerSeedHash(revealed.serverSeedHash);
  if (!committed.ok) return malformed('revealed.serverSeedHash', committed.error.kind);
  const clientSeed = parseClientSeed(revealed.clientSeed);
  if (!clientSeed.ok) return malformed('revealed.clientSeed', clientSeed.error.kind);
  const nextNonce = parseNonce(revealed.nextNonce);
  if (!nextNonce.ok) return malformed('revealed.nextNonce', nextNonce.error.kind);
  const nonce = parseNonce(record.nonce);
  if (!nonce.ok) return malformed('record.nonce', nonce.error.kind);
  const params = game.parseParams(record.params);
  if (!params.ok) return malformed('record.params', params.error);

  const computedHash = hashServerSeed(serverSeed.value);
  if (computedHash !== committed.value) {
    return err({ kind: 'HASH_MISMATCH', committed: committed.value, computed: computedHash });
  }
  if (record.serverSeedHash !== committed.value) return err({ kind: 'SEED_PAIR_MISMATCH', field: 'serverSeedHash' });
  if (record.clientSeed !== clientSeed.value) return err({ kind: 'SEED_PAIR_MISMATCH', field: 'clientSeed' });
  if (record.gameId !== game.id) return err({ kind: 'GAME_MISMATCH', expected: game.id, actual: String(record.gameId) });
  if (nonce.value >= nextNonce.value) {
    return err({ kind: 'NONCE_NOT_USED', nonce: nonce.value, nextNonce: nextNonce.value });
  }

  const computed = resolveOutcome(
    game,
    { serverSeed: serverSeed.value, clientSeed: clientSeed.value, nonce: nonce.value },
    params.value,
  );
  if (canonicalJson(computed) !== canonicalJson(record.outcome)) {
    return err({ kind: 'OUTCOME_MISMATCH', recorded: record.outcome, computed });
  }
  return ok(computed);
};

export const engine = {
  parseServerSeed,
  parseServerSeedHash,
  parseClientSeed,
  parseNonce,
  parseCursor,
  // 型がリテラルを保証するが、上限（MAX_SAFE_INTEGER）は型で検査しきれないので実行時にも検査する。
  nonceOf: (n) => expectOk(parseNonce(n)),
  cursorOf: (n) => expectOk(parseCursor(n)),
  generateServerSeed: () => unsafeBrand(randomBytes(32).toString('hex')),
  hashServerSeed,
  hmac,
  generateFloats: (input, count) => unsafeBrand(generateFloatsUnchecked(input, count)),
  createSeedPair,
  toPublic,
  play,
  rotate,
  verify,
} as const satisfies ProvablyFairEngine;
