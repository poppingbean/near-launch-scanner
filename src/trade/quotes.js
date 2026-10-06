// Quote tokens a launch pool may be paired with, and how the app gets there from NEAR.
//   wNEAR  - direct
//   NEARLY - DCL multi-hop in one swap: wNEAR → NEARLY → token (same route nearly.trade users take)
//   RHEA   - Ref v2 wNEAR→RHEA (deep pool #6458), then a second tx RHEA→token on DCL
// Pools quoted in anything else (ZEC, bridged BNB tokens, other memecoins) are never bought.
import { config } from '../config.js';
import { view } from '../near/rpc.js';

export const WNEAR = 'wrap.near';
export const DCL = 'dclv2.ref-labs.near', REFV2 = 'v2.ref-finance.near';

export const QUOTES = {
  'wrap.near': { symbol: 'wNEAR', bridge: null },
  'nearly-993927.nearlytrade.near': { symbol: 'NEARLY', bridge: { dex: 'dcl', poolId: 'nearly-993927.nearlytrade.near|wrap.near|10000' } },
  'token.rhealab.near': { symbol: 'RHEA', bridge: { dex: 'refv2', poolId: 6458 } },
};

export const quoteSymbol = (q) => QUOTES[q]?.symbol || q;
export const isAcceptedQuote = (q) => !!QUOTES[q] && config.acceptedQuotes.includes(q);

const tokenDecimals = new Map([[WNEAR, 24]]);
export async function decimals(token) {
  if (!tokenDecimals.has(token)) { try { tokenDecimals.set(token, (await view(token, 'ft_metadata')).decimals); } catch { tokenDecimals.set(token, 18); } }
  return tokenDecimals.get(token);
}
export const units = (raw, dec) => Number(BigInt(raw) / 10n ** BigInt(Math.max(0, dec - 6))) / 10 ** Math.min(6, dec);

/** Raw amount of quote token `q` received for `amountInYocto` NEAR through its bridge pool. */
export async function bridgeOut(q, amountInYocto) {
  if (q === WNEAR) return amountInYocto;
  const b = QUOTES[q]?.bridge;
  if (!b) return '0';
  if (b.dex === 'dcl') return (await view(DCL, 'quote', { pool_ids: [b.poolId], input_token: WNEAR, output_token: q, input_amount: amountInYocto }))?.amount || '0';
  return (await view(REFV2, 'get_return', { pool_id: b.poolId, token_in: WNEAR, amount_in: amountInYocto, token_out: q })) || '0';
}

/** NEAR value of one whole quote token (from a 1-NEAR bridge quote), cached 60 s. */
const priceCache = new Map();
export async function quoteNearPrice(q) {
  if (q === WNEAR) return 1;
  const c = priceCache.get(q);
  if (c && Date.now() - c.ts < 60e3) return c.price;
  const out = units(await bridgeOut(q, (10n ** 24n).toString()), await decimals(q));
  const price = out > 0 ? 1 / out : 0;
  priceCache.set(q, { ts: Date.now(), price });
  return price;
}

/** NEAR price in USD from the deepest Ref DCL USDC/wNEAR pool (fee 0.01%), cached 5 min. */
const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
let usdCache = { ts: 0, price: null };
export async function nearUsdPrice() {
  if (usdCache.price && Date.now() - usdCache.ts < 300e3) return usdCache.price;
  try {
    const q = await view(DCL, 'quote', { pool_ids: [`${USDC}|wrap.near|100`], input_token: WNEAR, output_token: USDC, input_amount: (10n ** 24n).toString() });
    const price = Number(q?.amount || 0) / 1e6;
    if (price > 0) usdCache = { ts: Date.now(), price };
  } catch {}
  return usdCache.price;
}

/** Convert a raw quote-token amount into NEAR at the current bridge price. */
export async function quoteToNear(q, raw) {
  return units(raw || '0', await decimals(q)) * (await quoteNearPrice(q));
}
