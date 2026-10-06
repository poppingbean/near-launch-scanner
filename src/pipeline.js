// Token lifecycle: detected → raising → live → (observe) → rules → [tranche 1] → ai_review → [tranche 2]
//   final statuses: skipped | t1_* | t2_bought | t2_dry_run | t2_not_bought | t1_held_ai_hold | t1_sold_ai_sell | t1_held_exit_failed | approved | ai_rejected | failed_raise | stale
import { config } from './config.js';
import { state, upsertToken, rekeyToken, markDirty } from './store.js';
import { collectFeatures } from './analysis/onchain.js';
import { applyRules } from './analysis/rules.js';
import { aiReview, aiStatus } from './analysis/ai.js';
import { buy } from './trade/executor.js';
import { sellAll } from './trade/seller.js';
import { quoteSymbol, isAcceptedQuote } from './trade/quotes.js';
import { adapters } from './launchpads/index.js';
import { info, warn, error } from './log.js';

export function onEvent(ev, tx) {
  if (ev.kind === 'note') { info(`[${ev.launchpad}] ${ev.note}`); return; }
  if (ev.kind === 'created') {
    upsertToken(ev.key, { launchpad: ev.launchpad, creator: ev.creator, name: ev.name, symbol: ev.symbol, quote: ev.quote, status: ev.raise?.curve ? 'curve' : 'raising', createdTs: tx.ts, raise: ev.raise || null, raisedNear: 0, depositors: 0 });
    info(`NEW ${ev.launchpad} ${ev.symbol || ''} ${ev.key} by ${ev.creator}${ev.raise?.endTs ? ` (raise ends ${new Date(ev.raise.endTs).toISOString()})` : ''}`);
    return;
  }
  if (ev.kind === 'raise_progress') {
    const t = state.tokens[ev.key]; if (!t) return;
    t.raisedNear = +(t.raisedNear + ev.amountNear).toFixed(4); t.depositors += ev.amountNear > 0 ? 1 : 0; markDirty();
    return;
  }
  if (ev.kind === 'raise_failed') { if (state.tokens[ev.key]) { upsertToken(ev.key, { status: 'failed_raise', closedTs: tx.ts }); info(`RAISE FAILED ${ev.key}`); } return; }
  if (ev.kind === 'live') {
    const prev = state.tokens[ev.key] ? rekeyToken(ev.key, ev.token) : null;
    const t = upsertToken(ev.token, {
      launchpad: ev.launchpad, token: ev.token, creator: ev.creator || prev?.creator, name: ev.name || prev?.name, symbol: ev.symbol || prev?.symbol,
      pool: ev.pool, liquidityNear: ev.liquidityNear, devBuyNear: ev.devBuyNear, devBuyQuoteRaw: ev.devBuyQuoteRaw ?? null, lp: ev.lp, tax: ev.tax, notes: ev.notes,
      liveTs: tx.ts, liveTx: tx.hash, status: 'live',
      raiseSeconds: prev?.createdTs ? Math.round((tx.ts - prev.createdTs) / 1000) : null,
      raisedNear: prev?.raisedNear ?? (ev.liquidityNear || null),
    });
    info(`LIVE ${t.launchpad} ${t.symbol || ''} ${t.token} pool=${t.pool.poolId} quote=${quoteSymbol(t.pool.quote)}${isAcceptedQuote(t.pool.quote) ? '' : ' (not tradable)'} liquidity=${t.liquidityNear} NEAR devBuy=${t.devBuyNear ?? 'quote:' + t.devBuyQuoteRaw} NEAR${t.raiseSeconds != null ? ` raise=${(t.raiseSeconds / 3600).toFixed(1)}h` : ''}`);
  }
}

// AI reviews run in the background so a slow review never delays scanning or other tokens' tranche-1 buys.
const pending = new Set();
export const waitForPendingReviews = () => Promise.allSettled([...pending]);
export const pendingReviewCount = () => pending.size;

const tradeStatus = (r, prefix) => (r.status === 'bought' ? `${prefix}_bought` : r.status === 'dry_run' ? `${prefix}_dry_run` : `${prefix}_not_bought`);

/**
 * Score one live token and act on the result. Exported so the CLI can evaluate any token on demand.
 * Flow: hard rules → (pass) buy tranche 1 immediately → AI review (background) → (approve) buy tranche 2.
 */
export async function evaluate(t, { allowBuy = true, awaitAi = false } = {}) {
  // Pools quoted in something we can't route to (ZEC, bridged tokens, other memecoins) are skipped without the full analysis.
  if (!isAcceptedQuote(t.pool.quote) || (t.pool.dex !== 'dcl' && t.pool.quote !== 'wrap.near')) {
    upsertToken(t.token, { status: 'skipped_quote', evaluatedTs: Date.now(), evaluation: { score: null, failed: ['quote_accepted'], ai: null, features: null } });
    info(`SKIP ${t.symbol || ''} ${t.token}: pool quote ${quoteSymbol(t.pool.quote)} not accepted (ACCEPTED_QUOTES)`);
    return { features: null, rules: null, ai: null, decision: 'SKIP' };
  }
  const features = await collectFeatures(t, config.trading.buyAmountNear);
  const rules = applyRules(features);
  const canTrade = allowBuy && adapters[t.launchpad]?.trades;
  const evaluation = { score: rules.score, failed: rules.failed.map((g) => g.id), ai: null, features };
  info(`RULES ${t.symbol || ''} ${t.token}: ${rules.pass ? 'PASS' : 'FAIL'} (score ${rules.score}${rules.score < config.rules.minScore ? ` < min ${config.rules.minScore}` : ''}${rules.failed.length ? '; ' + rules.failed.map((g) => g.why).join(' | ') : ''})`);
  if (!rules.pass) {
    upsertToken(t.token, { status: 'skipped', evaluatedTs: Date.now(), evaluation });
    return { features, rules, ai: null, decision: 'SKIP' };
  }

  // Tranche 1: buy right away so a slow AI review can't make us miss the entry.
  let t1 = null;
  if (canTrade && config.ai.enabled && config.ai.requireReady && aiStatus.ok !== true) {
    t1 = { status: 'blocked', tranche: 1, reason: `AI not ready: ${aiStatus.error || 'health check pending'}` };
    warn(`BUY T1 held back for ${t.token}: ${t1.reason}`);
    upsertToken(t.token, { trade: { t1 } });
  } else if (canTrade) {
    t1 = await buy(t, { tranche: 1 });
    upsertToken(t.token, { trade: { t1 } });
  }
  upsertToken(t.token, { status: 'ai_review', evaluatedTs: Date.now(), evaluation });

  const review = reviewAndTopUp(t, features, rules, t1, canTrade);
  if (awaitAi) return review;
  pending.add(review); review.finally(() => pending.delete(review));
  return { features, rules, ai: null, decision: 'PENDING_AI' };
}

async function reviewAndTopUp(t, features, rules, t1, canTrade) {
  let ai = null;
  if (config.ai.enabled) {
    try { ai = await aiReview(features, rules); } catch (e) { warn(`AI review failed for ${t.token}: ${e.message}`); }
  }
  // The AI recommends BUY_MORE / HOLD / SELL for the starter bag. BUY_MORE below the confidence bar becomes HOLD;
  // SELL is followed whatever its confidence. No AI result → AI_FAILURE_ACTION; AI disabled → rules alone decide (BUY_MORE).
  const failAction = config.aiFailureAction === 'hold' ? 'HOLD' : 'SELL';
  let action = !config.ai.enabled ? 'BUY_MORE' : !ai ? failAction : ai.action;
  let why = !config.ai.enabled ? 'AI disabled' : !ai ? `AI review failed → ${failAction}` : `AI ${ai.action} ${ai.confidence} [${ai.risk_level}]`;
  if (action === 'BUY_MORE' && ai && ai.confidence < config.ai.minConfidence) { action = 'HOLD'; why += ` (confidence < ${config.ai.minConfidence} → HOLD)`; }
  const decision = action === 'BUY_MORE' ? 'BUY' : 'SKIP';
  state.tokens[t.token].evaluation.ai = ai;
  state.tokens[t.token].evaluation.action = action;
  info(`AI ${t.symbol || ''} ${t.token}: ${why} → ${action}`);

  const t1ok = t1 && (t1.status === 'bought' || t1.status === 'dry_run');
  if (!canTrade) { upsertToken(t.token, { status: { BUY_MORE: 'approved', HOLD: 'ai_hold', SELL: 'ai_sell' }[action] }); return { features, rules, ai, decision, action }; }
  if (!t1ok) { upsertToken(t.token, { status: tradeStatus(t1 || {}, 't1') }); return { features, rules, ai, decision, action }; }
  const paper = t1.status === 'dry_run';

  if (action === 'HOLD') {
    // Keep the starter bag; take-profit monitoring and the Sell buttons still apply.
    upsertToken(t.token, { status: paper ? 'ai_hold_dry_run' : 't1_held_ai_hold' });
    info(`HOLD ${t.token}: keeping the ${config.trading.firstTrancheNear} NEAR starter position, no top-up`);
    return { features, rules, ai, decision, action };
  }
  if (action === 'SELL') {
    const exit = await sellAll(t.token, why);
    upsertToken(t.token, {
      status: exit.status === 'sold' ? 't1_sold_ai_sell' : exit.status === 'dry_run' ? 'ai_sell_dry_run_sold' : 't1_held_exit_failed',
      trade: { t1, exit: { status: exit.status, reason: exit.reason, hash: exit.hash, plan: exit.plan } },
    });
    return { features, rules, ai, decision, action };
  }
  const t2 = config.trading.secondTrancheNear > 0 ? await buy(state.tokens[t.token], { tranche: 2, refPrice: t1.plan?.unitPrice }) : { status: t1.status };
  upsertToken(t.token, { status: tradeStatus(t2, 't2'), trade: { t1, t2 } });
  return { features, rules, ai, decision, action };
}

/** Called every poll: evaluate tokens whose observation window has elapsed. */
export async function tick() {
  const now = Date.now();
  for (const t of Object.values(state.tokens)) {
    if (t.status !== 'live') continue;
    const age = (now - t.liveTs) / 1000;
    if (age > config.maxTokenAgeMinutes * 60) { upsertToken(t.token, { status: 'stale' }); continue; }
    const minAge = Math.max(config.observeSeconds, t.launchpad === 'justhoot' ? config.justhootMinAgeSeconds : 0);
    if (age < minAge) continue;
    try { await evaluate(t); } catch (e) { error(`evaluate ${t.token} failed: ${e.message}`); upsertToken(t.token, { status: 'error', error: e.message }); }
  }
}
