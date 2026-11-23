import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dice, engine } from '../src/index.js';
import type { BetRecord, Result } from '../src/index.js';

const unwrap = <T, E>(r: Result<T, E>): T => {
  if (!r.ok) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r.value;
};

const SEED = unwrap(engine.parseServerSeed('a3f1'.repeat(16)));
const CLIENT = unwrap(engine.parseClientSeed('player-seed'));
const NONCE = engine.nonceOf(7);

// 期待値は Python（hashlib / hmac、float = Σ b_i / 256^(i+1)）で独立に計算したもの。
test('SHA-256 と HMAC は既知の値と一致する', () => {
  assert.equal(engine.hashServerSeed(SEED), '40f01b99607201f4d394d89042b93e62aab9ced9a54c030f1549512dcb675f5f');
  const digest = engine.hmac({ serverSeed: SEED, clientSeed: CLIENT, nonce: NONCE, cursor: engine.cursorOf(0) });
  assert.equal(Buffer.from(digest).toString('hex'), '7aec947f319a64e8271c8a01f9f26aeb473f7d40321ce30138fc7affbfb9b046');
});

test('float 列は既知の値と一致し、9 個目以降は cursor 1 から取られる', () => {
  const floats = engine.generateFloats({ serverSeed: SEED, clientSeed: CLIENT, nonce: NONCE }, 10);
  assert.deepEqual(floats, [
    0.4801724252756685, 0.19376211799681187, 0.15277922176755965, 0.9763552497606725, 0.2783125191926956,
    0.19575327658094466, 0.22260254598222673, 0.748927132692188, 0.7186823422089219, 0.07064394792541862,
  ]);
});

test('generateFloats は型を迂回した不正な個数を実行時にも拒否する', () => {
  const input = { serverSeed: SEED, clientSeed: CLIENT, nonce: NONCE };
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => engine.generateFloats(input, bad as 1), RangeError);
  }
});

test('パーサは境界値を正しく扱う', () => {
  assert.equal(engine.parseServerSeed('A3F1'.repeat(16)).ok, false, '大文字は不可');
  assert.equal(engine.parseServerSeed('a'.repeat(63)).ok, false);
  assert.equal(engine.parseClientSeed('').ok, false);
  assert.equal(engine.parseClientSeed('x'.repeat(64)).ok, true);
  assert.equal(engine.parseClientSeed('x'.repeat(65)).ok, false);
  assert.deepEqual(engine.parseClientSeed('ab:c'), {
    ok: false,
    error: { kind: 'CLIENT_SEED_INVALID_CHAR', index: 2, char: ':' },
  });
  assert.equal(engine.parseClientSeed('a b').ok, false, '空白は不可');
  assert.equal(engine.parseClientSeed('あ').ok, false, '非 ASCII は不可');
  for (const bad of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(engine.parseNonce(bad).ok, false, String(bad));
  }
  assert.equal(unwrap(engine.parseNonce(-0)), 0);
  assert.ok(Object.is(unwrap(engine.parseNonce(-0)), 0), '-0 は 0 に正規化');
  assert.equal(unwrap(engine.parseNonce(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

test('nonceOf は型で検査しきれない上限超えを実行時に拒否する', () => {
  assert.throws(() => engine.nonceOf(9007199254740993));
});

const playSession = () => {
  let pair = engine.createSeedPair(SEED, CLIENT);
  const records: BetRecord<typeof dice>[] = [];
  for (let i = 0; i < 3; i++) {
    const r = engine.play(pair, dice, { target: 50 });
    pair = r.pair;
    records.push(r.record);
  }
  const { revealed, next } = engine.rotate(pair, engine.generateServerSeed(), CLIENT);
  return { records, revealed, next };
};

test('play → rotate → verify の一連の流れが成功する', () => {
  const { records, revealed, next } = playSession();
  assert.deepEqual(records.map((r) => r.nonce), [0, 1, 2]);
  assert.equal(revealed.nextNonce, 3);
  assert.equal(next.nonce, 0);
  assert.notEqual(next.serverSeed, SEED);
  for (const record of records) {
    assert.deepEqual(engine.verify(revealed, record, dice), { ok: true, value: record.outcome });
  }
  // 結果はキー順に依存せず比較される
  const reordered = { ...records[0]!, outcome: { win: records[0]!.outcome.win, roll: records[0]!.outcome.roll } };
  assert.equal(engine.verify(revealed, reordered, dice).ok, true);
});

test('verify は改ざんを検出する', () => {
  const { records, revealed } = playSession();
  const record = records[0]!;
  const kind = (r: ReturnType<typeof engine.verify<typeof dice>>) => (r.ok ? 'OK' : r.error.kind);

  const otherSeed = engine.generateServerSeed();
  assert.equal(kind(engine.verify({ ...revealed, serverSeed: otherSeed }, record, dice)), 'HASH_MISMATCH');
  assert.equal(
    kind(engine.verify(revealed, { ...record, clientSeed: unwrap(engine.parseClientSeed('other')) }, dice)),
    'SEED_PAIR_MISMATCH',
  );
  assert.equal(
    kind(engine.verify(revealed, { ...record, serverSeedHash: engine.hashServerSeed(otherSeed) }, dice)),
    'SEED_PAIR_MISMATCH',
  );
  assert.equal(kind(engine.verify(revealed, { ...record, nonce: engine.nonceOf(3) }, dice)), 'NONCE_NOT_USED');
  assert.equal(
    kind(engine.verify(revealed, { ...record, outcome: { ...record.outcome, win: !record.outcome.win } }, dice)),
    'OUTCOME_MISMATCH',
  );
  assert.equal(kind(engine.verify(revealed, { ...record, gameId: 'limbo' as 'dice' }, dice)), 'GAME_MISMATCH');
  // 型を偽った外部データ
  assert.equal(kind(engine.verify(revealed, { ...record, nonce: -1 as never }, dice)), 'MALFORMED_INPUT');
  assert.equal(kind(engine.verify(revealed, { ...record, params: { target: '50' } as never }, dice)), 'MALFORMED_INPUT');
  assert.equal(kind(engine.verify({ ...revealed, serverSeed: 'zz' as never }, record, dice)), 'MALFORMED_INPUT');
});

test('toPublic は実行時にも serverSeed を含まない', () => {
  const pub = engine.toPublic(engine.createSeedPair(SEED, CLIENT));
  assert.equal('serverSeed' in pub, false);
  assert.equal(JSON.stringify(pub).includes(SEED), false);
});

test('rotate は公開済みシードの再利用を拒否する', () => {
  assert.throws(() => engine.rotate(engine.createSeedPair(SEED, CLIENT), SEED, CLIENT));
});

test('generateServerSeed は形式を満たし、毎回異なる', () => {
  const a = engine.generateServerSeed();
  assert.equal(engine.parseServerSeed(a).ok, true);
  assert.notEqual(a, engine.generateServerSeed());
});

test('dice のパラメータ検査', () => {
  for (const bad of [{}, null, { target: 1 }, { target: 99 }, { target: 50.5 }, { target: '50' }]) {
    assert.equal(dice.parseParams(bad).ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(dice.parseParams({ target: 2 }), { ok: true, value: { target: 2 } });
});
