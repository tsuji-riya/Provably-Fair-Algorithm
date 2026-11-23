import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dice } from './games/dice.js';
import { engine } from './engine.js';
import type { BetRecord, SecretSeedPair } from './types.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const MAX_BODY_BYTES = 1024;
const INDEX_HTML = new URL('../../web/index.html', import.meta.url);

// shortcut: プロセス全体で 1 プレイヤー分の状態をメモリに持つ。複数プレイヤーや再起動後の継続が必要になったら
//           セッション ID ごとの永続ストアに置き換える。
let pair: SecretSeedPair = engine.createSeedPair(engine.generateServerSeed(), defaultClientSeed());
let bets: BetRecord<typeof dice>[] = [];

/** プレイヤーが指定するまでの初期 ClientSeed。16 進なので必ず ClientSeed の形式を満たす。 */
function defaultClientSeed() {
  const r = engine.parseClientSeed(randomBytes(8).toString('hex'));
  if (!r.ok) throw new Error('unreachable: hex is a valid client seed');
  return r.value;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 信用できない入力。サイズ上限と JSON 構文を検査する。 */
const readJson = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
};

const state = () => ({ pair: engine.toPublic(pair), bets });

const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'GET /': async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(INDEX_HTML));
  },
  'GET /api/state': async (_req, res) => send(res, 200, state()),
  'POST /api/bet': async (req, res) => {
    const params = dice.parseParams(await readJson(req));
    if (!params.ok) throw new HttpError(400, params.error);
    const result = engine.play(pair, dice, params.value);
    pair = result.pair;
    bets.push(result.record);
    send(res, 200, { record: result.record, pair: engine.toPublic(pair) });
  },
  'POST /api/rotate': async (req, res) => {
    const body = await readJson(req);
    const raw = typeof body === 'object' && body !== null && 'clientSeed' in body ? body.clientSeed : undefined;
    if (typeof raw !== 'string') throw new HttpError(400, 'clientSeed must be a string');
    const clientSeed = engine.parseClientSeed(raw);
    if (!clientSeed.ok) throw new HttpError(400, clientSeed.error.kind);
    const { revealed, next } = engine.rotate(pair, engine.generateServerSeed(), clientSeed.value);
    const revealedBets = bets;
    pair = next;
    bets = [];
    send(res, 200, { revealed, revealedBets, pair: engine.toPublic(pair) });
  },
};

createServer((req, res) => {
  const route = routes[`${req.method} ${req.url}`];
  if (!route) return send(res, 404, { error: 'not found' });
  route(req, res).catch((e: unknown) => {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'internal error' });
  });
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
