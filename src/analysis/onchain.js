// Collects the on-chain features used for scoring a freshly launched token.
// Every feature here maps to a pattern seen in our investigations (HOOT, DIARHEA, NINU, SINGULARTY, NEARDOGE).
import { view, viewAccount, fastnearGet, txIndexer, yoctoToNear } from '../near/rpc.js';
import { fetchTxs, accountTxHashes, decodeTx } from '../near/indexer.js';
import { state, markDirty } from '../store.js';
import { DCL, REFV2, WNEAR, QUOTES, decimals, units, bridgeOut, quoteNearPrice, quoteToNear, quoteSymbol, isAcceptedQuote, nearUsdPrice } from '../trade/quotes.js';

const INFRA = /^(dclv2\.ref-labs\.near|v2\.ref-finance\.near|aggregatedex\.near|dex\.intear\.near|nearlytrade\.near|lock2\.nearlytrade\.near|meme-cooking\.near|launchpad\.justhoot\.near|token-locker\.ref-labs\.near|intents\.near|feeswap\.near)$/;
const AGGREGATORS = /^(aggregatedex\.near|dex\.intear\.near|router\.aurabot\.near|cosmosnock\.near)$/;
/**
 * Current pool reserves (quote side valued in NEAR) and an executable quote for `buyNear` NEAR,
 * including the route the buy will take (direct, DCL multi-hop via NEARLY, or Ref v2 → DCL via RHEA).
 */
export async function poolSnapshot(t, buyNear) {
  const amountIn = (BigInt(Math.round(buyNear * 1e6)) * 10n ** 18n).toString();
  const dec = await decimals(t.token);
  const q = t.pool.quote, pid = t.pool.poolId;
  if (t.pool.dex === 'dcl') {
    const p = await view(DCL, 'get_pool', { pool_id: pid });
    const nearReserve = await quoteToNear(q, p.token_x === t.token ? p.total_y : p.total_x);
    const dclQuote = async (pool_ids, input_token, input_amount) => (await view(DCL, 'quote', { pool_ids, input_token, output_token: t.token, input_amount }).catch(() => null))?.amount || '0';
    let route = null, out = '0';
    const b = QUOTES[q]?.bridge;
    if (q === WNEAR) { route = { kind: 'direct', poolIds: [pid] }; out = await dclQuote([pid], WNEAR, amountIn); }
    else if (b?.dex === 'dcl') { route = { kind: 'dcl_multihop', poolIds: [b.poolId, pid] }; out = await dclQuote(route.poolIds, WNEAR, amountIn); }
    else if (b?.dex === 'refv2') {
      const mid = await bridgeOut(q, amountIn);
      route = { kind: 'refv2_then_dcl', bridgePool: b.poolId, quoteToken: q, midRaw: mid, poolIds: [pid] };
      out = mid !== '0' ? await dclQuote([pid], q, mid) : '0';
    }
    return { nearReserve, quoteOutRaw: out, quoteOut: units(out, dec), amountIn, route };
  }
  const p = await view(REFV2, 'get_pool', { pool_id: t.pool.poolId });
  const i = p.token_account_ids.indexOf(WNEAR); // meme.cooking Ref v2 pools are always wNEAR-paired
  if (i < 0) return { nearReserve: 0, quoteOutRaw: '0', quoteOut: 0, amountIn, route: null };
  const nearReserve = yoctoToNear(p.amounts[i]);
  const out = await view(REFV2, 'get_return', { pool_id: t.pool.poolId, token_in: WNEAR, amount_in: amountIn, token_out: t.token });
  return { nearReserve, quoteOutRaw: out || '0', quoteOut: units(out || '0', dec), amountIn, route: { kind: 'refv2', poolIds: [t.pool.poolId] } };
}

/** Every buy/sell of the token since it went live, from its contract's tx history. */
export async function earlyTrades(t) {
  const { rows } = await accountTxHashes(t.token, 6);
  const hashes = rows.filter((r) => Number(r.tx_block_timestamp.slice(0, 13)) >= t.liveTs - 1000).map((r) => r.transaction_hash);
  const txs = await fetchTxs(hashes);
  const dec = await decimals(t.token);
  const q = t.pool.quote, qDec = await decimals(q), qPx = await quoteNearPrice(q); // current price; good enough for early-window sizing
  const trades = [];
  for (const tx of txs) {
    if (tx.failed) continue;
    const refunded = new Set(tx.events.filter((e) => e.event === 'ft_transfer' && (e.data || []).some((d) => /refund/.test(d.memo || ''))).flatMap((e) => e.data.map((d) => d.amount)));
    if (t.pool.dex === 'dcl') {
      for (const e of tx.events.filter((x) => x.executor === DCL && x.event === 'swap')) for (const s of e.data || []) {
        if (s.pool_id !== t.pool.poolId || refunded.has(s.amount_in) || s.amount_in === '0') continue;
        const buy = s.token_in === q;
        if (!buy && s.token_in !== t.token) continue;
        const trader = AGGREGATORS.test(s.swapper) ? tx.signer : s.swapper;
        trades.push({ ts: tx.ts, hash: tx.hash, trader, buy, near: units(buy ? s.amount_in : s.amount_out, qDec) * qPx, tokens: units(buy ? s.amount_out : s.amount_in, dec) });
      }
    } else {
      for (const l of tx.logs.filter((x) => x.executor === REFV2)) {
        const m = l.text.match(/^Swapped (\d+) (\S+) for (\d+) (\S+)/); if (!m) continue;
        const buy = m[2] === WNEAR && m[4] === t.token, sell = m[2] === t.token && m[4] === WNEAR; if (!buy && !sell) continue;
        trades.push({ ts: tx.ts, hash: tx.hash, trader: tx.signer, buy, near: yoctoToNear(buy ? m[1] : m[3]), tokens: units(buy ? m[3] : m[1], dec) });
      }
    }
  }
  return trades.sort((a, b) => a.ts - b.ts);
}

/** Wallet profile: age, size of history, first funder. Fresh wallets have short histories, so the oldest tx is reachable. */
const profileCache = new Map();
export async function walletProfile(account) {
  if (profileCache.has(account)) return profileCache.get(account);
  let p = { account, txCount: null, firstTs: null, funder: null, funderTxCount: null, fresh: false };
  try {
    const { rows, count, complete } = await accountTxHashes(account, 2);
    p.txCount = count;
    if (complete && rows.length) {
      const oldest = rows.slice(-3).map((r) => r.transaction_hash);
      const txs = await fetchTxs(oldest);
      p.firstTs = txs[0]?.ts ?? null;
      const fund = txs.find((x) => x.receiver === account && x.signer !== account) || txs.find((x) => x.signer !== account);
      p.funder = fund ? fund.signer : null;
      p.fresh = p.firstTs ? Date.now() - p.firstTs < 3 * 86400e3 : false;
    }
    if (p.funder) p.funderTxCount = (await txIndexer('/v0/account', { account_id: p.funder })).txs_count ?? null;
  } catch {}
  profileCache.set(account, p);
  return p;
}
// Funders that say nothing about common ownership: exchanges / payout hot wallets, NEAR Intents, account relayers.
const isGenericFunder = (p) => !p.funder || p.funder === 'intents.near' || /relayer|herewallet|meteor|intear|^near$/.test(p.funder) || (p.funderTxCount ?? 0) > 20000;

// Token code each launchpad deploys (observed 2026-10-05). nearly.trade and justhoot use NEAR global contracts.
const KNOWN_CODE = {
  // nearly.trade runs several template versions side by side (e.g. 8GXV… carries the optional buy/sell tax); all are global contracts it deploys.
  nearlytrade: ['HS4R2isPS7hnnY8k2QbxnLHUx9Z9v9mNZnLsrGqwhChh', '8GXVnFTxx1d6tYnoqNiQ5YzzQpj1uyxG7u28LeCGmsER', '54GH1DmZgArERRH2ed8zJBXT7UxdeumaZe8Du8dtYJrt'],
  justhoot: ['6YL5fBS6ymwmnCbf2Rq9XD3MhC95pSBptqLXzGrnr41L'],
  memecooking: ['7cs332A22JGVpG9urbTyd7A23kDDGB3juEAuLPxuKfRo'],
};

async function codeHashCheck(t) {
  try {
    const a = await viewAccount(t.token);
    const codeHash = a.global_contract_hash || a.global_contract_account_id || a.code_hash;
    const tpl = state.templates[t.launchpad] || (state.templates[t.launchpad] = {});
    tpl[codeHash] = (tpl[codeHash] || 0) + 1; markDirty();
    // Accept the known launchpad code, or a code this launchpad has deployed for >= 3 tokens (launchpad upgrades).
    const accepted = new Set([...(KNOWN_CODE[t.launchpad] || []), ...Object.entries(tpl).filter(([, n]) => n >= 3).map(([h]) => h)]);
    return { codeHash, global: !!a.global_contract_hash, matchesTemplate: accepted.has(codeHash) };
  } catch { return { codeHash: null, global: null, matchesTemplate: null }; }
}

/** Build the full feature set for one live token. */
export async function collectFeatures(t, buyNear) {
  const q = t.pool.quote;
  const devBuyNear = t.devBuyNear ?? (t.devBuyQuoteRaw ? await quoteToNear(q, t.devBuyQuoteRaw).catch(() => null) : 0);
  const [pool, trades, code, top] = await Promise.all([poolSnapshot(t, buyNear), earlyTrades(t), codeHashCheck(t), fastnearGet(`/v1/ft/${t.token}/top`)]);
  const ext = trades.filter((x) => x.trader !== t.creator);
  const buys = ext.filter((x) => x.buy), sells = ext.filter((x) => !x.buy);
  const byBuyer = {}; for (const b of buys) byBuyer[b.trader] = (byBuyer[b.trader] || 0) + b.near;
  const buyNearTotal = buys.reduce((s, x) => s + x.near, 0);
  const topBuyers = Object.entries(byBuyer).sort((a, b) => b[1] - a[1]);

  // same-second clusters: >=3 distinct wallets buying within 2 s with sizes within 25%
  let syncClusters = 0;
  for (let i = 0; i < buys.length; i++) {
    const g = buys.filter((x) => Math.abs(x.ts - buys[i].ts) <= 2000);
    const w = new Set(g.map((x) => x.trader));
    if (w.size >= 3) { const n = g.map((x) => x.near); if (Math.min(...n) / Math.max(...n) > 0.75) { syncClusters++; i += g.length - 1; } }
  }

  // wallet links: creator + top 8 buyers, linked if they share a non-generic funder or the creator funded them
  const watch = [t.creator, ...topBuyers.slice(0, 8).map(([a]) => a)].filter(Boolean);
  const profiles = await Promise.all(watch.map(walletProfile));
  const P = Object.fromEntries(profiles.map((p) => [p.account, p]));
  const funderGroups = {};
  for (const p of profiles) if (!isGenericFunder(p)) (funderGroups[p.funder] = funderGroups[p.funder] || []).push(p.account);
  const linked = new Set();
  for (const ws of Object.values(funderGroups)) if (ws.length >= 2) ws.forEach((w) => linked.add(w));
  for (const p of profiles) if (p.funder === t.creator) linked.add(p.account);
  const linkedBuyNear = topBuyers.filter(([a]) => linked.has(a)).reduce((s, [, v]) => s + v, 0);

  const prices = trades.filter((x) => x.tokens > 0).map((x) => x.near / x.tokens);
  const holders = (top?.accounts || []).map((h) => ({ account: h.account_id, raw: h.balance })).filter((h) => !INFRA.test(h.account) && h.account !== t.token);
  const supplyRaw = BigInt(await view(t.token, 'ft_total_supply').catch(() => '0'));
  const share = (raw) => (supplyRaw > 0n ? Number((BigInt(raw) * 10000n) / supplyRaw) / 10000 : 0);
  // Market cap (fully diluted: spot price × total supply), spot price from a 0.1 NEAR quote.
  const [spot, nearUsd] = await Promise.all([poolSnapshot(t, 0.1).catch(() => null), nearUsdPrice()]);
  const tokDec = await decimals(t.token);
  const priceNear = spot?.quoteOut > 0 ? 0.1 / spot.quoteOut : null;
  const supply = units(supplyRaw.toString(), tokDec);
  const mcapNear = priceNear != null ? priceNear * supply : null;
  const creatorPrev = Object.values(state.tokens).filter((x) => x.creator === t.creator && x.key !== t.key && x.status !== 'detected').length;

  return {
    token: t.token, launchpad: t.launchpad, name: t.name, symbol: t.symbol,
    ageSeconds: Math.round((Date.now() - t.liveTs) / 1000),
    pool: { dex: t.pool.dex, quote: q, quoteSymbol: quoteSymbol(q), quoteAccepted: isAcceptedQuote(q), quoteNearPrice: await quoteNearPrice(q).catch(() => 0), route: pool.route?.kind || null, nearReserve: +pool.nearReserve.toFixed(2), initialLiquidityNear: t.liquidityNear, lpLocked: t.lp?.locked ?? null, quoteForBuy: { near: buyNear, tokensOut: pool.quoteOut } },
    launch: { devBuyNear: devBuyNear == null ? null : +devBuyNear.toFixed(2), tax: t.tax, raisedNear: t.raisedNear ?? null, raiseSeconds: t.raiseSeconds ?? null, notes: t.notes || [] },
    contract: code,
    market: { priceNear, totalSupply: supply, mcapNear: mcapNear != null ? +mcapNear.toFixed(1) : null, nearUsd, mcapUsd: mcapNear != null && nearUsd ? Math.round(mcapNear * nearUsd) : null },
    trading: {
      firstTradeDelaySeconds: trades[0] ? Math.round((trades[0].ts - t.liveTs) / 1000) : null,
      uniqueBuyers: Object.keys(byBuyer).length, uniqueSellers: new Set(sells.map((x) => x.trader)).size,
      buyNear: +buyNearTotal.toFixed(2), sellNear: +sells.reduce((s, x) => s + x.near, 0).toFixed(2),
      creatorBuyNear: +trades.filter((x) => x.trader === t.creator && x.buy).reduce((s, x) => s + x.near, 0).toFixed(2),
      creatorSold: trades.some((x) => x.trader === t.creator && !x.buy),
      topBuyerShare: buyNearTotal ? +(topBuyers[0][1] / buyNearTotal).toFixed(3) : 0,
      top3BuyerShare: buyNearTotal ? +(topBuyers.slice(0, 3).reduce((s, [, v]) => s + v, 0) / buyNearTotal).toFixed(3) : 0,
      syncBuyClusters: syncClusters,
      priceMultipleSinceFirstTrade: prices.length > 1 ? +(prices[prices.length - 1] / prices[0]).toFixed(2) : 1,
    },
    wallets: {
      creator: P[t.creator] ? { fresh: P[t.creator].fresh, txCount: P[t.creator].txCount, funder: P[t.creator].funder, funderLooksGeneric: isGenericFunder(P[t.creator]) } : null,
      creatorPreviousLaunchesSeen: creatorPrev,
      topBuyers: topBuyers.slice(0, 8).map(([a, v]) => ({ account: a, near: +v.toFixed(2), fresh: P[a]?.fresh ?? null, funder: P[a]?.funder ?? null, linked: linked.has(a) })),
      linkedBuyerShare: buyNearTotal ? +(linkedBuyNear / buyNearTotal).toFixed(3) : 0,
      creatorFundedBuyers: profiles.filter((p) => p.funder === t.creator).map((p) => p.account),
    },
    holders: {
      top10ShareExPool: +holders.slice(0, 10).reduce((s, h) => s + share(h.raw), 0).toFixed(3),
      creatorShare: share(holders.find((h) => h.account === t.creator)?.raw || '0'),
      count: holders.length,
    },
  };
}
