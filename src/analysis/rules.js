// Deterministic gates + a 0-100 score. Gates encode lessons from the investigations; any failed gate means SKIP.
import { config } from '../config.js';

export function applyRules(f) {
  const R = config.rules;
  const gates = [];
  const gate = (ok, id, why) => gates.push({ id, ok: !!ok, why });

  gate(f.pool.quoteAccepted && f.pool.route, 'quote_accepted', `pool quote is ${f.pool.quoteSymbol}; only wNEAR / NEARLY / RHEA pools with a known route are bought`);
  gate(f.contract.matchesTemplate === true, 'standard_contract', 'token code differs from the launchpad template (custom contract = honeypot risk, cf. NEARDOGE)');
  gate(f.pool.lpLocked !== false, 'lp_locked', 'liquidity is not locked by the launchpad');
  gate(f.pool.nearReserve >= R.minPoolNear, 'min_pool_near', `pool has ${f.pool.nearReserve} NEAR (< ${R.minPoolNear})`);
  gate(f.trading.uniqueBuyers >= R.minUniqueBuyers, 'min_buyers', `${f.trading.uniqueBuyers} distinct external buyers (< ${R.minUniqueBuyers})`);
  gate(!f.trading.creatorSold, 'creator_not_selling', 'creator already sold');
  const tax = f.launch.tax || {};
  const taxBps = (tax.buyBps || 0) + (tax.sellBps || 0) + Math.round((tax.transferFeePips || 0) / 100) * 2;
  gate(taxBps <= R.maxTaxBps, 'tax_ok', `round-trip tax ~${taxBps / 100}% (> ${R.maxTaxBps / 100}%)`);
  // Buyer / holder concentration is accepted: we enter in the first minutes, when a few early buyers holding a large share
  // is normal. Coordination (linked wallets, creator-funded buyers) is still a hard gate below.
  gate(f.wallets.linkedBuyerShare <= R.maxLinkedBuyerShare, 'no_sybil_cluster', `${(f.wallets.linkedBuyerShare * 100).toFixed(0)}% of buying comes from wallets linked to each other or the creator`);
  gate(f.wallets.creatorFundedBuyers.length === 0, 'creator_not_funding_buyers', `creator funded buyers: ${f.wallets.creatorFundedBuyers.join(', ')}`);
  // Run-up since the first trade only matters once the token is no longer small: below the market-cap threshold it's still early.
  const early = f.market.mcapUsd != null && f.market.mcapUsd < R.ignoreRunupBelowMcapUsd;
  const mcapText = f.market.mcapUsd != null ? `$${f.market.mcapUsd.toLocaleString('en-US')}` : 'unknown';
  gate(early || f.trading.priceMultipleSinceFirstTrade <= R.maxPriceMultipleSinceLaunch, 'not_overextended', `price already ${f.trading.priceMultipleSinceFirstTrade}x since first trade at market cap ${mcapText}`);
  gate(f.pool.quoteForBuy.tokensOut > 0, 'quote_available', 'no executable quote for the buy size');

  // Soft score: demand breadth, organic flow, sane holder structure.
  let score = 50;
  score += Math.min(20, f.trading.uniqueBuyers * 1.5);
  score += f.trading.buyNear > 0 ? Math.max(-15, Math.min(10, ((f.trading.buyNear - f.trading.sellNear) / f.trading.buyNear) * 10)) : -10;
  score -= f.trading.syncBuyClusters * 6;
  score -= f.wallets.creator?.fresh && !f.wallets.creator?.funderLooksGeneric ? 5 : 0;
  score += f.pool.nearReserve >= 100 ? 5 : 0;
  score -= f.wallets.linkedBuyerShare * 20;
  if (f.launchpad === 'memecooking' && f.launch.raisedNear >= 150) score += 5; // broader raise
  score = Math.max(0, Math.min(100, Math.round(score)));

  const failed = gates.filter((g) => !g.ok);
  return { pass: failed.length === 0 && score >= R.minScore, score, failed, gates };
}
