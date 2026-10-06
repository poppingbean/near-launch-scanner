// Launchpad adapters. Each turns a decoded tx (see near/indexer.js decodeTx) into normalised lifecycle events:
//   created        - a token/raise was announced              { key, launchpad, creator, name, symbol, quote, raise? }
//   raise_progress - a deposit into a raise (meme.cooking)    { key, account, amountNear }
//   raise_failed   - a raise ended without launching          { key }
//   live           - liquidity is in a pool, trading can start { key, token, creator, pool, liquidityNear, devBuyNear, lp, tax, notes }
// Amounts are converted to NEAR where the quote is wNEAR; other quotes keep the raw amount (devBuyQuoteRaw) for later valuation.
import { yoctoToNear } from '../near/rpc.js';

const DCL = 'dclv2.ref-labs.near', REFV2 = 'v2.ref-finance.near';

// Pool facts that any launch tx reveals through Ref DCL events.
// DCL pool ids are "tokenA|tokenB|fee" with the two tokens sorted alphabetically, so the token can be on either side.
const poolHasToken = (poolId, token) => !!poolId && poolId.split('|').slice(0, 2).includes(token);
function dclPoolFacts(tx, token) {
  const create = tx.events.find((e) => e.executor === DCL && e.event === 'create_pool' && poolHasToken(e.data?.[0]?.pool_id, token));
  const liq = tx.events.filter((e) => e.executor === DCL && e.event === 'liquidity_added' && poolHasToken(e.data?.[0]?.pool_id, token));
  const poolId = create?.data[0].pool_id || liq[0]?.data[0].pool_id;
  return { poolId, lpOwners: [...new Set(liq.map((e) => e.data[0].owner_id))] };
}

export const adapters = {
  // ---------------------------------------------------------------- nearly.trade ("nearpad" events)
  nearlytrade: {
    account: 'nearlytrade.near',
    trades: true,
    parse(tx) {
      const out = [];
      const ev = (name) => tx.events.filter((e) => e.executor === 'nearlytrade.near' && e.standard === 'nearpad' && e.event === name).map((e) => e.data?.[0]);
      const taxById = Object.fromEntries(ev('tax_opts').map((d) => [d.id, d]));
      for (const d of ev('launch')) {
        // DCL pool ids list the two tokens alphabetically ("wrap.near|zapor...|fee"), so the quote is whichever side isn't the token.
        const quote = d.pool_id?.split('|').slice(0, 2).find((x) => x !== d.token);
        const tax = taxById[d.id];
        const devBuy = tx.events.find((e) => e.event === 'first_buy_done' && e.data?.[0]?.id === d.id);
        out.push({
          kind: 'live', key: d.token, token: d.token, launchpad: 'nearlytrade', launchId: d.id, creator: d.creator, name: d.name, symbol: d.symbol,
          pool: { dex: 'dcl', poolId: d.pool_id, quote },
          liquidityNear: 0, // nearly.trade launches are single-sided: tokens only, no NEAR side
          // Dev buy is paid in the pool's quote token; non-wNEAR amounts are valued in NEAR later (collectFeatures).
          devBuyNear: quote === 'wrap.near' ? (devBuy ? yoctoToNear(devBuy.data[0].used || '0') : (d.dev_buy_near ? yoctoToNear(d.dev_buy_near) : 0)) : (devBuy ? null : 0),
          devBuyQuoteRaw: quote !== 'wrap.near' && devBuy ? devBuy.data[0].used || '0' : null,
          lp: { owner: 'lock2.nearlytrade.near', locked: true },
          tax: tax ? { buyBps: tax.buy_bps, sellBps: tax.sell_bps, creatorBps: tax.creator_bps, burnBps: tax.burn_bps, holdersBps: tax.holders_bps } : null,
          notes: [],
        });
      }
      for (const d of ev('launch_step_failed')) out.push({ kind: 'note', key: null, launchpad: 'nearlytrade', note: `launch ${d.id} step failed: ${d.step}` });
      return out;
    },
  },

  // ---------------------------------------------------------------- justhoot ("hoot_launcher" events)
  justhoot: {
    account: 'launchpad.justhoot.near',
    trades: true,
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.standard === 'hoot_launcher' && x.event === 'meme_launched')) {
        const d = e.data; const token = d.token_id;
        const f = dclPoolFacts(tx, token);
        const args = tx.calls.find((c) => c.method === 'launch_meme')?.args?.args || {};
        out.push({
          kind: 'live', key: token, token, launchpad: 'justhoot', creator: d.creator_id, name: args.name, symbol: args.symbol,
          pool: { dex: 'dcl', poolId: f.poolId, quote: d.quote_token_id },
          liquidityNear: 0,
          devBuyNear: d.quote_token_id === 'wrap.near' ? yoctoToNear(d.dev_buy_quote || '0') : (d.dev_buy_quote && d.dev_buy_quote !== '0' ? null : 0),
          devBuyQuoteRaw: d.quote_token_id !== 'wrap.near' && d.dev_buy_quote && d.dev_buy_quote !== '0' ? d.dev_buy_quote : null,
          lp: { owner: f.lpOwners.join(','), locked: f.lpOwners.every((o) => o === token) }, // LP held by the token contract itself
          tax: args.transfer_fee_pips ? { transferFeePips: args.transfer_fee_pips } : null,
          notes: ['justhoot can apply a "sniping tax" (100% of buys) in the first ~2 minutes'],
        });
      }
      return out;
    },
  },

  // ---------------------------------------------------------------- meme.cooking (raise → finalize → Ref v2 pool)
  memecooking: {
    account: 'meme-cooking.near',
    trades: true,
    parse(tx) {
      const out = [];
      const mc = tx.events.filter((e) => e.executor === 'meme-cooking.near' && e.standard === 'meme-cooking');
      for (const e of mc) {
        const d = e.data;
        if (e.event === 'create_meme') out.push({ kind: 'created', key: `meme#${d.meme_id}`, launchpad: 'memecooking', creator: d.owner, name: d.name, symbol: d.symbol, quote: 'wrap.near', raise: { memeId: d.meme_id, endTs: Number(d.end_timestamp_ms) } });
        if (e.event === 'deposit') out.push({ kind: 'raise_progress', key: `meme#${d.meme_id}`, account: d.account_id, amountNear: yoctoToNear(d.amount) });
        if (e.event === 'withdraw') out.push({ kind: 'raise_progress', key: `meme#${d.meme_id}`, account: d.account_id, amountNear: -yoctoToNear(d.amount) });
        if (e.event === 'create_token') {
          // The NEAR side of the new pool is in Ref v2's "Liquidity added [...]" log in the same tx.
          let liquidityNear = 0;
          for (const l of tx.logs) { const m = l.text.match(/^Liquidity added \["\d+ [^"]+", "(\d+) wrap\.near"\]/); if (l.executor === REFV2 && m) liquidityNear = yoctoToNear(m[1]); }
          const locked = tx.logs.some((l) => /to token-locker\.ref-labs\.near/.test(l.text));
          out.push({ kind: 'live', key: `meme#${d.meme_id}`, token: d.token_id, launchpad: 'memecooking', pool: { dex: 'refv2', poolId: d.pool_id, quote: 'wrap.near' }, liquidityNear, devBuyNear: 0, lp: { owner: 'meme-cooking.near', locked }, tax: null, notes: [] });
        }
      }
      // finalize without create_token in the same tx = raise did not reach its soft cap
      for (const e of mc.filter((x) => x.event === 'finalize')) if (!mc.some((x) => x.event === 'create_token' && x.data.meme_id === e.data.meme_id)) out.push({ kind: 'raise_failed', key: `meme#${e.data.meme_id}` });
      return out;
    },
  },

  // ---------------------------------------------------------------- gaypad (bonding curve; monitor only)
  gaypad: {
    account: 'gaypad.j1-racing.near',
    trades: false, // trading happens on the launchpad's own bonding curve, not a Ref pool - we only report it
    parse(tx) {
      const out = [];
      for (const e of tx.events.filter((x) => x.executor === 'gaypad.j1-racing.near')) {
        const d = Array.isArray(e.data) ? e.data[0] : e.data;
        if (e.event === 'token_sale_created') out.push({ kind: 'created', key: d.token_id, launchpad: 'gaypad', creator: d.account_id, quote: 'curve', raise: { curve: true } });
        if (e.event === 'token_launch_requested') out.push({ kind: 'note', key: d.token_id, launchpad: 'gaypad', note: `launch requested by ${d.account_id}` });
      }
      return out;
    },
  },
};
