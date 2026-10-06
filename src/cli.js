// Utilities:
//   node src/cli.js status                      tokens seen, decisions, positions
//   node src/cli.js evaluate <token> <launchpad> <launchTxHash>   score an existing launch (never buys)
//   node src/cli.js backfill <launchpad> <hours>  replay recent launches into the store (no evaluation)
//   node src/cli.js exit <token|--ai-rejected>    sell a whole position now (real sale in live mode)
import { state, save } from './store.js';
import { adapters } from './launchpads/index.js';
import { fetchTxs, accountTxHashes } from './near/indexer.js';
import { onEvent, evaluate } from './pipeline.js';
import { ftBalance } from './near/rpc.js';
import { config, isLive } from './config.js';
import { sellAll } from './trade/seller.js';
import { openPositions } from './store.js';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'status') {
  const by = {}; for (const t of Object.values(state.tokens)) by[t.status] = (by[t.status] || 0) + 1;
  console.log('tokens by status:', by);
  for (const t of Object.values(state.tokens).filter((x) => x.evaluation).sort((a, b) => b.evaluatedTs - a.evaluatedTs).slice(0, 20)) {
    const e = t.evaluation;
    console.log(`${new Date(t.evaluatedTs).toISOString().slice(5, 16)} ${t.status.padEnd(18)} ${(t.symbol || '').padEnd(10)} ${t.token.slice(0, 42).padEnd(43)} score ${String(e.score).padStart(3)} ${e.failed.length ? 'failed: ' + e.failed.join(',') : ''}${e.ai ? ` AI ${e.ai.decision} ${e.ai.confidence}` : ''}`);
  }
  console.log(`\npositions (${state.positions.length}), spent ${state.spend.reduce((s, x) => s + x.near, 0)} NEAR:`);
  for (const p of state.positions) console.log(`  ${new Date(p.ts).toISOString().slice(0, 16)}${p.paper ? ' [paper]' : ''} ${p.token} cost ${p.near} N  value ${p.valueNear ?? '?'} N  ROI ${p.roi == null ? '?' : (p.roi * 100).toFixed(0) + '%'}  realized ${p.realizedNear || 0} N${p.takeProfit ? '  (took profit)' : ''}  balance now: ${!p.paper && config.accountId ? (await ftBalance(p.token, config.accountId)).toString() : '-'}`);
} else if (cmd === 'evaluate') {
  const [token, launchpad, txHash] = args;
  if (!txHash) { console.error('usage: evaluate <token> <launchpad> <launchTxHash>'); process.exit(1); }
  const [tx] = await fetchTxs([txHash]);
  for (const ev of adapters[launchpad].parse(tx)) onEvent(ev, tx);
  const t = state.tokens[token];
  if (!t || !t.pool) { console.error('launch tx did not produce a live pool for', token); process.exit(1); }
  const r = await evaluate(t, { allowBuy: false, awaitAi: true });
  console.log(JSON.stringify({ decision: r.decision, score: r.rules?.score, failed: r.rules?.failed, ai: r.ai, features: r.features }, null, 1));
  save();
} else if (cmd === 'backfill') {
  const [launchpad, hours = '6'] = args; const a = adapters[launchpad];
  const since = Date.now() - Number(hours) * 3600e3;
  const { rows } = await accountTxHashes(a.account, 30);
  const txs = await fetchTxs(rows.filter((r) => Number(r.tx_block_timestamp.slice(0, 13)) >= since).map((r) => r.transaction_hash));
  let n = 0; for (const tx of txs) for (const ev of a.parse(tx)) { onEvent(ev, tx); n++; }
  for (const t of Object.values(state.tokens)) if (t.status === 'live') t.status = 'backfilled';
  save(); console.log(`backfilled ${n} events from ${txs.length} txs`);
} else if (cmd === 'exit') {
  // Sell whole positions: one token, or every position the AI rejected (t1_held_ai_rejected / t1_held_exit_failed).
  const [which] = args;
  if (!which) { console.error('usage: exit <token> | exit --ai-rejected'); process.exit(1); }
  const targets = which === '--ai-rejected'
    ? openPositions().filter((p) => ['t1_held_ai_rejected', 't1_held_exit_failed'].includes(state.tokens[p.token]?.status) && !p.exit).map((p) => p.token)
    : [which];
  console.log(`mode ${isLive() ? 'LIVE (real sales)' : 'DRY-RUN (paper)'} · selling: ${targets.join(', ') || 'nothing'}`);
  for (const token of targets) {
    const r = await sellAll(token, 'manual exit');
    if (r.status === 'sold' || r.status === 'dry_run') state.tokens[token].status = r.status === 'sold' ? 't1_sold_manual' : 'exit_dry_run';
    console.log(token, '→', r.status, r.nearOut != null ? r.nearOut.toFixed(4) + ' NEAR back' : '', r.reason || '', r.hash || '');
  }
  save();
} else {
  console.log('commands: status | evaluate <token> <launchpad> <launchTxHash> | backfill <launchpad> <hours> | exit <token|--ai-rejected>');
}
