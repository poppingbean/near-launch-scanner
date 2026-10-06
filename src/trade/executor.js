// Buys a token with NEAR through Ref DCL or Ref v2. Dry-run by default; live only with both env switches set.
// Routes (all message formats copied from real mainnet swaps, see README "How the buy is built"):
//   direct          wNEAR pool          1 tx  wrap.near: near_deposit + ft_transfer_call → DCL / Ref v2
//   dcl_multihop    NEARLY-quoted pool  1 tx  same, DCL Swap with pool_ids [NEARLY|wNEAR, token|NEARLY]
//   refv2_then_dcl  RHEA-quoted pool    2 tx  wNEAR→RHEA on Ref v2 #6458, then RHEA→token on DCL
import { Account, actions } from 'near-api-js';
import { config, isLive } from '../config.js';
import { view, viewAccount, yoctoToNear, ftBalance } from '../near/rpc.js';
import { state, markDirty, spentNear, buysToday, findPosition } from '../store.js';
import { poolSnapshot } from '../analysis/onchain.js';
import { DCL, REFV2, WNEAR, isAcceptedQuote, quoteSymbol } from './quotes.js';
import { info, warn } from '../log.js';
import { amountReceived } from './receipts.js';

const TGAS = 10n ** 12n;
const BRIDGE_SLIPPAGE_BPS = 200; // wNEAR→RHEA leg runs through a ~130k-NEAR pool; keep it tight

let account = null;
function wallet() {
  if (!account) account = new Account(config.accountId, config.rpcUrls[0], config.privateKey); // key stays in memory only
  return account;
}

/** Spend/limit checks. Returns a reason string if the buy must not happen.
 *  Tranche 1 opens a position (counts toward the daily cap); tranche 2 only tops up an open position. */
async function preflight(t, tranche, amountNear) {
  const T = config.trading;
  const pos = findPosition(t.token);
  if (tranche === 1 && pos) return 'already bought this token';
  if (tranche === 2) {
    if (!pos) return 'no tranche-1 position to top up';
    if (pos.tranches.some((x) => x.tranche === 2)) return 'tranche 2 already bought';
  }
  if (spentNear() + amountNear > T.maxTotalSpendNear) return `total spend cap reached (${spentNear()} / ${T.maxTotalSpendNear} NEAR)`;
  if (tranche === 1 && buysToday() >= T.maxBuysPerDay) return `daily buy cap reached (${T.maxBuysPerDay} tokens)`;
  if (config.accountId) {
    const acc = await viewAccount(config.accountId);
    const free = yoctoToNear(acc.amount) - Number(acc.storage_usage) * 1e-5; // 1e-5 NEAR per byte of storage
    if (free - amountNear < T.minNearReserve) return `wallet balance too low (${free.toFixed(2)} NEAR free, keep ${T.minNearReserve} reserve)`;
  }
  return null;
}

const withSlippage = (raw, bps) => ((BigInt(raw) * BigInt(10000 - bps)) / 10000n).toString();
const dclSwap = (poolIds, outputToken, minOut) => ({ receiver: DCL, gas: 180n * TGAS, msg: { Swap: { pool_ids: poolIds, output_token: outputToken, min_output_amount: minOut, swap_out_recipient: config.accountId || 'dry-run.near' } } });
const refSwap = (poolId, tokenIn, tokenOut, amountIn, minOut) => ({ receiver: REFV2, gas: 250n * TGAS, msg: { force: 0, actions: [{ pool_id: Number(poolId), token_in: tokenIn, token_out: tokenOut, amount_in: amountIn, min_amount_out: minOut }] } });

/** The transactions a buy needs, as plain data (logged in dry-run, signed in live mode). */
function buildSteps(t, snap, minOut) {
  const r = snap.route;
  if (r.kind === 'direct' || r.kind === 'dcl_multihop') return [{ from: WNEAR, wrap: true, amount: snap.amountIn, ...dclSwap(r.poolIds, t.token, minOut) }];
  if (r.kind === 'refv2') return [{ from: WNEAR, wrap: true, amount: snap.amountIn, ...refSwap(r.poolIds[0], WNEAR, t.token, snap.amountIn, minOut) }];
  if (r.kind === 'refv2_then_dcl') return [
    { from: WNEAR, wrap: true, amount: snap.amountIn, ...refSwap(r.bridgePool, WNEAR, r.quoteToken, snap.amountIn, withSlippage(r.midRaw, BRIDGE_SLIPPAGE_BPS)) },
    // amount and min-out of the second leg are recomputed in live mode from the quote tokens actually received
    { from: r.quoteToken, wrap: false, amount: r.midRaw, ...dclSwap(r.poolIds, t.token, minOut) },
  ];
  throw new Error(`no buy route for ${t.token} (quote ${t.pool.quote})`);
}

const failedTx = (res) => JSON.stringify(res?.status || {}).includes('Failure');
const txHash = (res) => res?.transaction?.hash || res?.transaction_outcome?.id;

/** NEP-145 storage registration so the account can hold `token`. */
async function ensureStorage(acc, token) {
  const reg = await view(token, 'storage_balance_of', { account_id: config.accountId }).catch(() => null);
  if (reg) return;
  const bounds = await view(token, 'storage_balance_bounds').catch(() => ({ min: '1250000000000000000000' }));
  await acc.signAndSendTransaction({ receiverId: token, actions: [actions.functionCall('storage_deposit', { account_id: config.accountId, registration_only: true }, 30n * TGAS, BigInt(bounds.min))] });
}

function sendStep(acc, step) {
  const call = actions.functionCall('ft_transfer_call', { receiver_id: step.receiver, amount: step.amount, msg: JSON.stringify(step.msg) }, step.gas, 1n);
  return acc.signAndSendTransaction({
    receiverId: step.from,
    throwOnFailure: false, // failures are handled (and reported) by the caller
    actions: step.wrap ? [actions.functionCall('near_deposit', {}, 10n * TGAS, BigInt(step.amount)), call] : [call],
  });
}

/** Book a fill: spend entry + position (paper positions track the quoted token amount as their holding). */
function recordFill(t, { tranche, amountNear, snap, price, hash, paper }) {
  state.spend.push({ ts: Date.now(), token: t.token, tranche, near: amountNear, hash, paper });
  let pos = findPosition(t.token);
  if (!pos) state.positions.push(pos = { token: t.token, symbol: t.symbol, ts: Date.now(), near: 0, expectedTokens: 0, heldRaw: '0', realizedNear: 0, launchpad: t.launchpad, paper, tranches: [] });
  pos.tranches.push({ tranche, ts: Date.now(), near: amountNear, expectedTokens: snap.quoteOut, unitPrice: price, route: snap.route.kind, hash });
  pos.near += amountNear; pos.expectedTokens += snap.quoteOut; pos.hash = hash;
  pos.heldRaw = (BigInt(pos.heldRaw || '0') + BigInt(snap.quoteOutRaw)).toString();
  markDirty();
}

/** NEAR paid per whole token at the quoted size (for the tranche-2 "did it run away" check). */
export const unitPrice = (near, tokensOut) => (tokensOut > 0 ? near / tokensOut : Infinity);

/**
 * Buy `amountNear` of the token as tranche 1 (right after the hard rules) or tranche 2 (after AI approval).
 * For tranche 2 pass `refPrice` (unit price paid in tranche 1): the top-up is skipped if the price rose
 * more than MAX_TRANCHE2_PRICE_RISE while the AI was reviewing.
 */
export async function buy(t, { tranche = 1, amountNear, refPrice = null } = {}) {
  const T = config.trading;
  amountNear ??= tranche === 1 ? T.firstTrancheNear : T.secondTrancheNear;
  const tag = `T${tranche}`;
  const blocked = await preflight(t, tranche, amountNear);
  if (blocked) { warn(`BUY ${tag} blocked for ${t.token}: ${blocked}`); return { status: 'blocked', tranche, reason: blocked }; }

  if (!isAcceptedQuote(t.pool.quote)) return { status: 'blocked', tranche, reason: `quote ${quoteSymbol(t.pool.quote)} not accepted` };
  const snap = await poolSnapshot(t, amountNear);
  if (!snap.route || BigInt(snap.quoteOutRaw) === 0n) return { status: 'blocked', tranche, reason: 'no quote / route' };
  const minOut = withSlippage(snap.quoteOutRaw, T.slippageBps);
  const steps = buildSteps(t, snap, minOut);
  const price = unitPrice(amountNear, snap.quoteOut);
  const plan = {
    tranche, token: t.token, dex: t.pool.dex, pool: t.pool.poolId, quote: quoteSymbol(t.pool.quote), route: snap.route.kind,
    near: amountNear, expectedTokens: snap.quoteOut, unitPrice: price, minOut,
    steps: steps.map((s) => ({ tx_to: s.from, near_deposit: s.wrap ? s.amount : undefined, ft_transfer_call: { receiver_id: s.receiver, amount: s.amount, msg: s.msg } })),
  };
  if (refPrice && price > refPrice * (1 + T.maxTranche2PriceRise)) {
    const reason = `price up ${((price / refPrice - 1) * 100).toFixed(0)}% since tranche 1 (> ${T.maxTranche2PriceRise * 100}%), not chasing`;
    warn(`BUY ${tag} skipped for ${t.token}: ${reason}`);
    return { status: 'blocked', tranche, reason, plan };
  }

  if (!isLive()) {
    info(`DRY-RUN buy ${tag} ${amountNear} NEAR of ${t.token} via ${snap.route.kind}`, plan);
    recordFill(t, { tranche, amountNear, snap, price, hash: null, paper: true });
    return { status: 'dry_run', tranche, plan };
  }

  const acc = wallet();
  await ensureStorage(acc, t.token);
  await ensureStorage(acc, WNEAR);
  let hash, failed, note = null;
  if (steps.length === 1) {
    const res = await sendStep(acc, steps[0]);
    hash = txHash(res); failed = failedTx(res);
  } else {
    // Two legs: NEAR → quote token, then quote token → launch token, using exactly what leg 1 delivered.
    const q = snap.route.quoteToken;
    await ensureStorage(acc, q);
    const before = await ftBalance(q, config.accountId);
    const r1 = await sendStep(acc, steps[0]);
    const got = failedTx(r1) ? 0n : await amountReceived(r1, q, config.accountId, before);
    if (failedTx(r1) || got <= 0n) {
      hash = txHash(r1); failed = true; note = `leg 1 (NEAR→${quoteSymbol(q)}) failed; wNEAR may be left in the wallet`;
    } else {
      const leg2 = await view(DCL, 'quote', { pool_ids: snap.route.poolIds, input_token: q, output_token: t.token, input_amount: got.toString() }).catch(() => null);
      const min2 = withSlippage(leg2?.amount || minOut, T.slippageBps);
      const r2 = await sendStep(acc, { from: q, wrap: false, amount: got.toString(), ...dclSwap(snap.route.poolIds, t.token, min2) });
      hash = txHash(r2); failed = failedTx(r2);
      if (failed) note = `leg 2 (${quoteSymbol(q)}→token) failed; ${got} raw ${quoteSymbol(q)} left in the wallet (leg 1 tx ${txHash(r1)})`;
    }
  }
  // A failed swap leaves wNEAR / the quote token in the wallet; still count it as spent (conservative).
  if (failed) { state.spend.push({ ts: Date.now(), token: t.token, tranche, near: amountNear, hash }); markDirty(); }
  else recordFill(t, { tranche, amountNear, snap, price, hash, paper: false });
  info(`${failed ? 'BUY FAILED' : 'BOUGHT'} ${tag} ${amountNear} NEAR of ${t.token} via ${snap.route.kind}`, { hash, note });
  return { status: failed ? 'failed' : 'bought', tranche, hash, reason: note, plan };
}
