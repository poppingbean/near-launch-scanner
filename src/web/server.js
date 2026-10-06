// Monitor UI on http://127.0.0.1:<DASHBOARD_PORT>. Read-only except for manual Sell on held positions.
// The sell endpoint is guarded against other websites in the same browser: loopback-only Host (DNS rebinding),
// same-origin check, JSON-only body and a random per-run token that only the served page knows.
// It never exposes the private key.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config, isLive } from '../config.js';
import { state, spentNear, buysToday } from '../store.js';
import { recentLogs, info, warn } from '../log.js';
import { pendingReviewCount } from '../pipeline.js';
import { quoteSymbol } from '../trade/quotes.js';
import { aiStatus } from '../analysis/ai.js';
import { sellPosition, unwrapAll } from '../trade/seller.js';
import { viewAccount, yoctoToNear, ftBalance } from '../near/rpc.js';

export const runtime = { startedTs: Date.now(), cycles: 0, lastCycleTs: null, lastPoll: {}, scanOnly: false };

const actionToken = crypto.randomBytes(24).toString('hex');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8').replace('__ACTION_TOKEN__', actionToken);

let walletCache = { ts: 0, value: null };
async function walletInfo() {
  if (!config.accountId) return null;
  if (Date.now() - walletCache.ts < 30e3) return walletCache.value;
  try {
    const a = await viewAccount(config.accountId);
    const w = await ftBalance('wrap.near', config.accountId);
    walletCache = { ts: Date.now(), value: { account: config.accountId, near: +(yoctoToNear(a.amount) - Number(a.storage_usage) * 1e-5).toFixed(3), wnear: +yoctoToNear(w.toString()).toFixed(4) } };
  } catch (e) { walletCache = { ts: Date.now(), value: { account: config.accountId, error: e.message } }; }
  return walletCache.value;
}

// Token list without the heavy feature blobs (those are served per token).
function slimToken(t) {
  const e = t.evaluation;
  return {
    key: t.key, token: t.token || null, launchpad: t.launchpad, symbol: t.symbol, name: t.name, creator: t.creator, status: t.status,
    createdTs: t.createdTs || t.firstSeen, liveTs: t.liveTs || null, evaluatedTs: t.evaluatedTs || null,
    raisedNear: t.raisedNear ?? null, depositors: t.depositors ?? null, raiseEndTs: t.raise?.endTs || null, raiseSeconds: t.raiseSeconds ?? null,
    liquidityNear: t.liquidityNear ?? null, devBuyNear: t.devBuyNear ?? null, pool: t.pool || null,
    score: e?.score ?? null, failed: e?.failed || [],
    ai: e?.ai ? { decision: e.ai.decision, action: e.action || e.ai.action || null, confidence: e.ai.confidence, risk_level: e.ai.risk_level } : null,
    buyers: e?.features?.trading?.uniqueBuyers ?? null, mcapUsd: e?.features?.market?.mcapUsd ?? null, poolNear: e?.features?.pool?.nearReserve ?? null,
    trade: t.trade ? Object.fromEntries(Object.entries(t.trade).map(([k, v]) => [k, v && { status: v.status, reason: v.reason, hash: v.hash, near: v.plan?.near }])) : null,
  };
}

async function api(path, url) {
  if (path === '/api/state') {
    const T = config.trading;
    return {
      now: Date.now(),
      mode: runtime.scanOnly ? 'SCAN_ONLY' : isLive() ? 'LIVE' : 'DRY_RUN',
      liveBook: isLive(), // which book (live or paper) the positions/spend views show; true in scan-only when live is configured
      runtime: { ...runtime, pendingReviews: pendingReviewCount() },
      limits: { firstTrancheNear: T.firstTrancheNear, secondTrancheNear: T.secondTrancheNear, maxTotalSpendNear: T.maxTotalSpendNear, maxBuysPerDay: T.maxBuysPerDay, minNearReserve: T.minNearReserve, slippageBps: T.slippageBps, maxTranche2PriceRise: T.maxTranche2PriceRise },
      ai: { enabled: config.ai.enabled, model: config.ai.model, minConfidence: config.ai.minConfidence, ...aiStatus },
      takeProfit: config.takeProfit, acceptedQuotes: config.acceptedQuotes.map((q) => quoteSymbol(q)),
      rules: config.rules, launchpads: config.launchpads, observeSeconds: config.observeSeconds, pollSeconds: config.pollSeconds,
      spentNear: spentNear(), buysToday: buysToday(),
      wallet: await walletInfo(),
      tokens: Object.values(state.tokens).map(slimToken).sort((a, b) => (b.liveTs || b.createdTs || 0) - (a.liveTs || a.createdTs || 0)).slice(0, 300),
      positions: state.positions,
    };
  }
  if (path === '/api/logs') {
    const after = Number(url.searchParams.get('after') || 0);
    return recentLogs.filter((l) => l.id > after);
  }
  if (path.startsWith('/api/token/')) {
    const t = state.tokens[decodeURIComponent(path.slice('/api/token/'.length))];
    return t || { error: 'not found' };
  }
  return undefined;
}

const readJson = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (d) => { body += d; if (body.length > 10000) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid JSON')); } });
  req.on('error', reject);
});

/** Reject anything that isn't the monitor page itself talking to this server. */
function actionAllowed(req, port) {
  const okHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  if (!okHosts.includes(req.headers.host)) return 'bad host';
  const origin = req.headers.origin;
  if (origin && !okHosts.map((h) => `http://${h}`).includes(origin)) return 'bad origin';
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) return 'json only';
  const tok = String(req.headers['x-action-token'] || '');
  if (tok.length !== actionToken.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(actionToken))) return 'bad token';
  return null;
}

async function action(path, body) {
  if (!['/api/sell', '/api/sell/preview', '/api/unwrap'].includes(path)) return undefined;
  if (runtime.scanOnly) return { status: 'skipped', reason: 'scan-only mode never trades' };
  if (path === '/api/unwrap') { const r = await unwrapAll(); walletCache.ts = 0; return r; }
  const share = Number(body.percent) / 100;
  if (!body.token || !(share > 0 && share <= 1)) return { status: 'skipped', reason: 'token and percent (1-100) required' };
  const r = await sellPosition(String(body.token), { share, reason: `manual (UI ${body.percent}%)`, preview: path === '/api/sell/preview' });
  if (path === '/api/sell') walletCache.ts = 0;
  return r;
}

export function startDashboard(port) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST') {
        const denied = actionAllowed(req, port);
        if (denied) { warn(`monitor: rejected ${url.pathname} (${denied})`); res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: denied })); return; }
        const out = await action(url.pathname, await readJson(req));
        if (out === undefined) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out));
        return;
      }
      if (req.method !== 'GET') { res.writeHead(405).end(); return; }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
        return;
      }
      const body = await api(url.pathname, url);
      if (body === undefined) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
    }
  });
  server.on('error', (e) => warn(`monitor UI failed to start on port ${port}: ${e.message}`));
  server.listen(port, '127.0.0.1', () => info(`monitor UI: http://localhost:${port}`));
  server.unref();
  return server;
}
