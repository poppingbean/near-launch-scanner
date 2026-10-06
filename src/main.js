// Main loop: poll each launchpad for new txs, turn them into lifecycle events, evaluate tokens that are ready.
//   node src/main.js            scan + evaluate (+ buy if live trading is enabled)
//   node src/main.js --scan-only  only detect and log launches
import { config, validateConfig, isLive } from './config.js';
import { adapters } from './launchpads/index.js';
import { newTxHashes, fetchTxs } from './near/indexer.js';
import { state, save, markDirty } from './store.js';
import { onEvent, tick, waitForPendingReviews } from './pipeline.js';
import { checkPositions, reconcileSales } from './trade/seller.js';
import { checkAi, aiStatus } from './analysis/ai.js';
import { startDashboard, runtime } from './web/server.js';
import { info, warn, error } from './log.js';

const scanOnly = process.argv.includes('--scan-only');
const errs = validateConfig({ needWallet: isLive() });
if (errs.length) { for (const e of errs) error(e); process.exit(1); }

info(`near-launch-scanner starting · mode=${scanOnly ? 'SCAN-ONLY' : isLive() ? 'LIVE TRADING' : 'DRY-RUN'} · launchpads=${config.launchpads.join(',')} · buy=${config.trading.firstTrancheNear}+${config.trading.secondTrancheNear} NEAR (rules→T1, AI→T2) · cap=${config.trading.maxTotalSpendNear} NEAR · AI=${config.ai.enabled ? `${config.ai.model} via ${config.ai.backend === 'cli' ? 'local claude CLI' : 'API'}` : 'off'}`);
if (isLive() && !scanOnly) warn(`LIVE TRADING ENABLED for ${config.accountId}. Tokens passing the rules are bought for ${config.trading.firstTrancheNear} NEAR, plus ${config.trading.secondTrancheNear} NEAR if the AI approves.`);

async function pollLaunchpad(name) {
  const a = adapters[name];
  const cursor = state.cursors[name] || 0;
  const { hashes, head } = await newTxHashes(a.account, cursor);
  if (cursor === 0) { state.cursors[name] = head; markDirty(); info(`[${name}] starting from block ${head} (history not replayed)`); return; }
  if (!hashes.length) return;
  const txs = await fetchTxs(hashes);
  for (const tx of txs) for (const ev of a.parse(tx)) onEvent(ev, tx);
  state.cursors[name] = head; markDirty();
}

// Reviews that were in flight when the app last stopped can't resume (tranche 2 is never bought for them).
for (const t of Object.values(state.tokens)) if (t.status === 'ai_review') { t.status = 'ai_review_interrupted'; markDirty(); }
runtime.scanOnly = scanOnly;
if (config.dashboardPort > 0) startDashboard(config.dashboardPort);

const probeAi = () => checkAi().then((s) => (s.ok ? info(`AI ready (${config.ai.backend === 'cli' ? 'local claude CLI' : 'API'}, ${config.ai.model})`) : warn(`AI NOT ready: ${s.error}${config.ai.requireReady ? ' - tranche-1 buys are held back until it works' : ''}`)));
if (config.ai.enabled && !scanOnly) probeAi();
reconcileSales().catch((e) => warn(`reconcile failed: ${e.message}`));

let stopping = false;
process.on('SIGINT', () => { stopping = true; info('stopping after this cycle…'); });

while (!stopping) {
  for (const name of config.launchpads) {
    if (!adapters[name]) { warn(`unknown launchpad ${name}`); continue; }
    try { await pollLaunchpad(name); runtime.lastPoll[name] = { ts: Date.now(), ok: true }; }
    catch (e) { error(`[${name}] poll failed: ${e.message}`); runtime.lastPoll[name] = { ts: Date.now(), ok: false, error: e.message }; }
  }
  if (!scanOnly) {
    try { await tick(); } catch (e) { error(`tick failed: ${e.message}`); }
    try { await checkPositions(); } catch (e) { error(`position check failed: ${e.message}`); }
    if (config.ai.enabled && aiStatus.ok === false && Date.now() - aiStatus.checkedTs > 600e3) probeAi();
  }
  save();
  runtime.cycles++; runtime.lastCycleTs = Date.now();
  await new Promise((r) => setTimeout(r, config.pollSeconds * 1000));
}
info('waiting for AI reviews in flight…');
await waitForPendingReviews();
save();
process.exit(0);
