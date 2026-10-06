// Position monitor + take-profit. Values every open position by quoting a sale of the whole holding back to NEAR;
// when ROI > TAKE_PROFIT_ROI (3 = +300%) it sells just enough tokens to receive TAKE_PROFIT_WITHDRAW_NEAR (2.5 N)
// and keeps the rest. Sell routes mirror the buy routes in reverse:
//   direct / dcl_multihop  1 tx   token → DCL Swap(output wrap.near), then near_withdraw
//   refv2                  1 tx   token → Ref v2 action(token → wNEAR), then near_withdraw
//   refv2_then_dcl (RHEA)  2 tx   token → RHEA on DCL, RHEA → wNEAR on Ref v2 #6458, then near_withdraw
import { Account, actions } from 'near-api-js';
import { config, isLive } from '../config.js';
import { view, ftBalance, yoctoToNear } from '../near/rpc.js';
import { state, markDirty, openPositions, findPosition } from '../store.js';
import { DCL, REFV2, WNEAR, QUOTES, decimals, units } from './quotes.js';
import { amountReceived, receivedFromDecodedTx } from './receipts.js';
import { fetchTxs } from '../near/indexer.js';
import { info, warn, error } from '../log.js';

const TGAS = 10n ** 12n;
let account = null;
const wallet = () => (account ??= new Account(config.accountId, config.rpcUrls[0], config.privateKey));
const withSlippage = (raw, bps) => (BigInt(raw) * BigInt(10000 - bps)) / 10000n;

/** Sell route for a token, derived from its pool (same pools the buy used). */
function sellRoute(t) {
  const q = t.pool.quote, pid = t.pool.poolId, b = QUOTES[q]?.bridge;
  if (t.pool.dex === 'refv2') return { kind: 'refv2', poolId: pid };
  if (q === WNEAR) return { kind: 'dcl', poolIds: [pid] };
  if (b?.dex === 'dcl') return { kind: 'dcl', poolIds: [pid, b.poolId] };
  if (b?.dex === 'refv2') return { kind: 'dcl_then_refv2', poolIds: [pid], quoteToken: q, bridgePool: b.poolId };
  return null;
}

/** yoctoNEAR received for selling `amountRaw` of the token (0n if no route / no liquidity). */
export async function quoteSell(t, amountRaw) {
  const r = sellRoute(t); const amt = BigInt(amountRaw);
  if (!r || amt <= 0n) return 0n;
  try {
    if (r.kind === 'dcl') return BigInt((await view(DCL, 'quote', { pool_ids: r.poolIds, input_token: t.token, output_token: WNEAR, input_amount: amt.toString() }))?.amount || '0');
    if (r.kind === 'refv2') return BigInt((await view(REFV2, 'get_return', { pool_id: Number(r.poolId), token_in: t.token, amount_in: amt.toString(), token_out: WNEAR })) || '0');
    const mid = (await view(DCL, 'quote', { pool_ids: r.poolIds, input_token: t.token, output_token: r.quoteToken, input_amount: amt.toString() }))?.amount || '0';
    if (mid === '0') return 0n;
    return BigInt((await view(REFV2, 'get_return', { pool_id: r.bridgePool, token_in: r.quoteToken, amount_in: mid, token_out: WNEAR })) || '0');
  } catch { return 0n; }
}

/**
 * Largest part of the holding the pool can actually fill. DCL quotes 0 when a sale would run past the
 * available liquidity, so halve until it fills. Unfillable remainder is valued at 0 (conservative).
 */
async function fillable(t, heldRaw) {
  let amount = heldRaw;
  for (let i = 0; i < 8 && amount > 0n; i++, amount /= 2n) {
    const out = await quoteSell(t, amount);
    if (out > 0n) return { amount, out };
  }
  return { amount: 0n, out: 0n };
}

/** Smallest token amount whose sale yields at least `targetYocto` (bisection; sale proceeds rise with amount). */
async function amountForNear(t, heldRaw, targetYocto) {
  const f = await fillable(t, heldRaw);
  let lo = 0n, hi = f.amount;
  if (f.out < targetYocto) return f.amount; // can't reach the target: sell what the pool can fill
  for (let i = 0; i < 24 && hi - lo > heldRaw / 100000n + 1n; i++) {
    const mid = (lo + hi) / 2n;
    if ((await quoteSell(t, mid)) >= targetYocto) hi = mid; else lo = mid;
  }
  return hi;
}

const failedTx = (res) => JSON.stringify(res?.status || {}).includes('Failure');
const txHash = (res) => res?.transaction?.hash || res?.transaction_outcome?.id;
const ftCall = (acc, tokenContract, receiver, amount, msg, gas) =>
  acc.signAndSendTransaction({ receiverId: tokenContract, throwOnFailure: false, actions: [actions.functionCall('ft_transfer_call', { receiver_id: receiver, amount: amount.toString(), msg: JSON.stringify(msg) }, gas, 1n)] });

/** Live sale of `amountRaw` tokens with a NEAR floor of `minYocto`. Returns { hash, nearOut, failed, note }. */
async function executeSell(t, amountRaw, minYocto) {
  const acc = wallet(), r = sellRoute(t), me = config.accountId;
  const wBefore = await ftBalance(WNEAR, me);
  let res, note = null;
  if (r.kind === 'dcl') {
    res = await ftCall(acc, t.token, DCL, amountRaw, { Swap: { pool_ids: r.poolIds, output_token: WNEAR, min_output_amount: minYocto.toString(), skip_unwrap_near: true } }, 180n * TGAS);
  } else if (r.kind === 'refv2') {
    res = await ftCall(acc, t.token, REFV2, amountRaw, { force: 0, actions: [{ pool_id: Number(r.poolId), token_in: t.token, token_out: WNEAR, amount_in: amountRaw.toString(), min_amount_out: minYocto.toString() }] }, 250n * TGAS);
  } else {
    const qBefore = await ftBalance(r.quoteToken, me);
    const r1 = await ftCall(acc, t.token, DCL, amountRaw, { Swap: { pool_ids: r.poolIds, output_token: r.quoteToken, min_output_amount: '0' } }, 180n * TGAS);
    const got = failedTx(r1) ? 0n : await amountReceived(r1, r.quoteToken, me, qBefore);
    if (failedTx(r1) || got <= 0n) return { hash: txHash(r1), nearOut: 0, failed: true, note: 'leg 1 (token→quote) failed' };
    res = await ftCall(acc, r.quoteToken, REFV2, got, { force: 0, actions: [{ pool_id: r.bridgePool, token_in: r.quoteToken, token_out: WNEAR, amount_in: got.toString(), min_amount_out: minYocto.toString() }] }, 250n * TGAS);
    if (failedTx(res)) note = `leg 2 failed; ${got} raw ${QUOTES[r.quoteToken].symbol} left in the wallet`;
  }
  const wGot = failedTx(res) ? 0n : await amountReceived(res, WNEAR, me, wBefore);
  if (wGot > 0n) {
    const u = await acc.signAndSendTransaction({ receiverId: WNEAR, throwOnFailure: false, actions: [actions.functionCall('near_withdraw', { amount: wGot.toString() }, 10n * TGAS, 1n)] });
    if (failedTx(u)) note = [note, `unwrap failed; ${yoctoToNear(wGot.toString()).toFixed(4)} wNEAR left in the wallet (use Unwrap on the monitor)`].filter(Boolean).join('; ');
  } else if (!failedTx(res)) note = [note, 'swap succeeded but the wNEAR amount could not be read; check the wallet and use Unwrap on the monitor'].filter(Boolean).join('; ');
  return { hash: txHash(res), nearOut: yoctoToNear(wGot.toString()), failed: failedTx(res), note };
}

/** Value one position, record ROI, and take profit once if ROI crosses the threshold. */
async function checkPosition(pos) {
  const t = state.tokens[pos.token];
  if (!t?.pool) return;
  const dec = await decimals(t.token);
  // Live: real wallet balance. Paper (dry-run): what the buys were quoted to deliver, minus paper sales.
  const heldRaw = pos.paper ? BigInt(pos.heldRaw || '0') : await ftBalance(t.token, config.accountId);
  const { out: valueYocto } = await fillable(t, heldRaw);
  const value = yoctoToNear(valueYocto.toString());
  const cost = pos.near;
  const roi = cost > 0 ? (value + (pos.realizedNear || 0)) / cost - 1 : 0;
  Object.assign(pos, { heldTokens: units(heldRaw.toString(), dec), valueNear: +value.toFixed(4), roi: +roi.toFixed(4), checkedTs: Date.now() });
  markDirty();

  const TP = config.takeProfit;
  if (!TP.enabled || pos.takeProfit || roi <= TP.roi || heldRaw === 0n) return;
  const target = BigInt(Math.round(TP.withdrawNear * 1e6)) * 10n ** 18n;
  const sellRaw = await amountForNear(t, heldRaw, target);
  if (sellRaw === 0n) { warn(`take profit ${t.token}: pool cannot fill any sale right now`); return; }
  const expected = await quoteSell(t, sellRaw);
  const minOut = withSlippage(expected, config.trading.slippageBps);
  const plan = { token: t.token, roi: pos.roi, valueNear: pos.valueNear, sellTokens: units(sellRaw.toString(), dec), sellShare: +(Number((sellRaw * 10000n) / heldRaw) / 100).toFixed(2), expectedNear: yoctoToNear(expected.toString()), minNear: yoctoToNear(minOut.toString()), route: sellRoute(t)?.kind };
  info(`TAKE PROFIT ${t.symbol || ''} ${t.token}: ROI ${(roi * 100).toFixed(0)}% > ${TP.roi * 100}% → sell ${plan.sellShare}% of holding for ~${plan.expectedNear.toFixed(3)} NEAR, keep the rest`, plan);

  if (pos.paper) {
    pos.heldRaw = (heldRaw - sellRaw).toString();
    pos.realizedNear = (pos.realizedNear || 0) + plan.expectedNear;
    pos.takeProfit = { ts: Date.now(), paper: true, ...plan };
    markDirty();
    return;
  }
  if (!isLive()) return; // live position seen while running in dry-run: report only
  const r = await executeSell(t, sellRaw, minOut);
  pos.takeProfit = { ts: Date.now(), ...plan, hash: r.hash, nearOut: r.nearOut, failed: r.failed, note: r.note };
  if (!r.failed) pos.realizedNear = (pos.realizedNear || 0) + r.nearOut;
  markDirty();
  (r.failed ? warn : info)(`${r.failed ? 'TAKE PROFIT FAILED' : 'TOOK PROFIT'} ${t.token}: ${r.nearOut.toFixed(3)} NEAR back`, { hash: r.hash, note: r.note });
}

const selling = new Set(); // tokens with a sale in flight (UI double-clicks, AI exit + manual sell)

/**
 * Sell `share` (0-1] of a position now. Used for the AI-reject exit (share 1) and the monitor's Sell buttons.
 * With `preview: true` it only quotes. Sells what the pool can fill; any unfillable part stays in the wallet.
 */
export async function sellPosition(token, { share = 1, reason = 'manual', preview = false } = {}) {
  const pos = findPosition(token);
  const t = state.tokens[token];
  if (!pos || !t?.pool) return { status: 'skipped', reason: 'no open position' };
  if (!sellRoute(t)) return { status: 'skipped', reason: 'no sell route' };
  if (!(share > 0 && share <= 1)) return { status: 'skipped', reason: 'share must be in (0, 1]' };
  if (!preview && selling.has(token)) return { status: 'skipped', reason: 'a sale of this token is already in progress' };
  const dec = await decimals(t.token);
  const heldRaw = pos.paper ? BigInt(pos.heldRaw || '0') : await ftBalance(t.token, config.accountId);
  if (heldRaw === 0n) return { status: 'skipped', reason: 'zero balance' };
  const wanted = share >= 1 ? heldRaw : (heldRaw * BigInt(Math.round(share * 1e6))) / 1000000n;
  const f = await fillable(t, wanted);
  if (f.amount === 0n) return { status: 'failed', reason: 'pool cannot fill any sale right now' };
  const minOut = withSlippage(f.out, config.trading.slippageBps);
  const plan = {
    token, symbol: t.symbol, reason, sellTokens: units(f.amount.toString(), dec), heldTokens: units(heldRaw.toString(), dec),
    sellShare: +(Number((f.amount * 10000n) / heldRaw) / 100).toFixed(2), expectedNear: yoctoToNear(f.out.toString()),
    minNear: yoctoToNear(minOut.toString()), cost: pos.near, route: sellRoute(t).kind, paper: !!pos.paper,
  };
  if (preview) return { status: 'preview', plan };

  selling.add(token);
  try {
    info(`SELL ${t.symbol || ''} ${token} (${reason}): ${plan.sellShare}% of holding for ~${plan.expectedNear.toFixed(3)} NEAR (cost ${pos.near} NEAR)`, plan);
    let sale;
    if (pos.paper) {
      pos.heldRaw = (heldRaw - f.amount).toString();
      sale = { ts: Date.now(), paper: true, ...plan, nearOut: plan.expectedNear, failed: false };
    } else {
      if (!isLive()) return { status: 'skipped', reason: 'live position while running in dry-run' };
      const r = await executeSell(t, f.amount, minOut);
      sale = { ts: Date.now(), ...plan, hash: r.hash, nearOut: r.nearOut, failed: r.failed, note: r.note };
      (r.failed ? warn : info)(`${r.failed ? 'SELL FAILED' : 'SOLD'} ${token}: ${r.nearOut.toFixed(3)} NEAR back`, { hash: r.hash, note: r.note });
    }
    (pos.sales ||= []).push(sale);
    if (!sale.failed) pos.realizedNear = (pos.realizedNear || 0) + sale.nearOut;
    if (plan.sellShare >= 99.99 || reason.startsWith('AI')) {
      pos.exit = sale; // full exit (or AI-reject exit) shown as "exited"
      if (!sale.failed && plan.sellShare >= 99.99) Object.assign(pos, { valueNear: 0, heldTokens: 0, roi: +((pos.realizedNear || 0) / pos.near - 1).toFixed(4) });
      if (!sale.failed && plan.sellShare >= 99.99 && !reason.startsWith('AI')) t.status = pos.paper ? 'exit_dry_run' : 'sold_manual';
    }
    markDirty();
    return { status: sale.failed ? 'failed' : pos.paper ? 'dry_run' : 'sold', hash: sale.hash, nearOut: sale.nearOut, reason: sale.note, plan };
  } finally { selling.delete(token); }
}

/** Exit a whole position right away (AI rejected the token after tranche 1, or `npm run exit`). */
export const sellAll = (token, reason) => sellPosition(token, { share: 1, reason });

/** Convert the wallet's whole wNEAR balance back to NEAR (leftovers from a failed unwrap or a failed buy). */
export async function unwrapAll() {
  if (!isLive()) return { status: 'skipped', reason: 'only in live mode' };
  const bal = await ftBalance(WNEAR, config.accountId);
  if (bal === 0n) return { status: 'skipped', reason: 'no wNEAR in the wallet' };
  const res = await wallet().signAndSendTransaction({ receiverId: WNEAR, throwOnFailure: false, actions: [actions.functionCall('near_withdraw', { amount: bal.toString() }, 10n * TGAS, 1n)] });
  const ok = !failedTx(res);
  (ok ? info : warn)(`${ok ? 'UNWRAPPED' : 'UNWRAP FAILED'} ${yoctoToNear(bal.toString()).toFixed(4)} wNEAR`, { hash: txHash(res) });
  return { status: ok ? 'unwrapped' : 'failed', near: yoctoToNear(bal.toString()), hash: txHash(res) };
}

/**
 * Fix sales recorded as "0 NEAR back" by older versions (they read the wallet balance too early).
 * Re-reads each such transaction and books the wNEAR it actually delivered.
 */
export async function reconcileSales() {
  for (const pos of state.positions.filter((p) => !p.paper)) for (const sale of pos.sales || []) {
    if (sale.failed || sale.nearOut > 0 || !sale.hash || sale.reconciled) continue;
    try {
      const [tx] = await fetchTxs([sale.hash]);
      const got = tx ? receivedFromDecodedTx(tx, WNEAR, config.accountId) : 0n;
      if (got === 0n) continue;
      sale.nearOut = yoctoToNear(got.toString()); sale.reconciled = true;
      sale.note = [sale.note, 'amount reconciled from the tx; the wNEAR was not unwrapped at the time'].filter(Boolean).join('; ');
      pos.realizedNear = (pos.realizedNear || 0) + sale.nearOut;
      if (pos.exit && pos.exit.hash === sale.hash) Object.assign(pos.exit, { nearOut: sale.nearOut, reconciled: true, note: sale.note });
      if (sale.sellShare >= 99.99 && state.tokens[pos.token]) state.tokens[pos.token].status = 'sold_manual';
      markDirty();
      info(`RECONCILED sale of ${pos.token}: ${sale.nearOut.toFixed(4)} NEAR (was recorded as 0)`, { hash: sale.hash });
    } catch (e) { warn(`reconcile ${pos.token} failed: ${e.message}`); }
  }
}

let lastCheck = 0;
/** Called from the main loop; checks every POSITION_CHECK_SECONDS. */
export async function checkPositions({ force = false } = {}) {
  if (!force && Date.now() - lastCheck < config.positionCheckSeconds * 1000) return;
  lastCheck = Date.now();
  for (const pos of openPositions()) {
    try { await checkPosition(pos); } catch (e) { error(`position check ${pos.token} failed: ${e.message}`); }
  }
}
