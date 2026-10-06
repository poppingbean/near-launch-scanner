// Configuration and safety limits. Everything comes from .env; defaults are conservative (no live trading).
import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(String(v)));
const list = (v, d) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  // --- network / data sources ---
  rpcUrls: list(process.env.NEAR_RPC_URLS, ['https://rpc.mainnet.fastnear.com', 'https://free.rpc.fastnear.com', 'https://near.lava.build']),
  txIndexerUrl: process.env.FASTNEAR_TX_URL || 'https://tx.main.fastnear.com',
  fastnearApiUrl: process.env.FASTNEAR_API_URL || 'https://api.fastnear.com',
  fastnearApiKey: process.env.FASTNEAR_API_KEY || '',

  // --- scanning ---
  launchpads: list(process.env.LAUNCHPADS, ['nearlytrade', 'justhoot', 'memecooking', 'gaypad']),
  // Pool quote tokens the app will buy through (see src/trade/quotes.js for the routes).
  acceptedQuotes: list(process.env.ACCEPTED_QUOTES, ['wrap.near', 'nearly-993927.nearlytrade.near', 'token.rhealab.near']),
  pollSeconds: num(process.env.POLL_SECONDS, 15),
  // How long to watch trading after liquidity goes live before scoring (early bots trade within ~5-180 s).
  observeSeconds: num(process.env.OBSERVE_SECONDS, 300),
  // justhoot applies a ~2 min "sniping tax" (100% of the buy is confiscated); never buy before this.
  justhootMinAgeSeconds: num(process.env.JUSTHOOT_MIN_AGE_SECONDS, 240),
  // Ignore tokens whose liquidity went live longer ago than this (stale).
  maxTokenAgeMinutes: num(process.env.MAX_TOKEN_AGE_MINUTES, 60),

  // --- rule thresholds (hard gates) ---
  rules: {
    minPoolNear: num(process.env.MIN_POOL_NEAR, 20),
    minUniqueBuyers: num(process.env.MIN_UNIQUE_BUYERS, 5),
    maxTaxBps: num(process.env.MAX_TAX_BPS, 1000),
    maxLinkedBuyerShare: num(process.env.MAX_LINKED_BUYER_SHARE, 0.4),
    maxPriceMultipleSinceLaunch: num(process.env.MAX_PRICE_MULTIPLE, 8),
    // Below this fully diluted market cap the token is still early: the price run-up since the first trade is not checked.
    ignoreRunupBelowMcapUsd: num(process.env.IGNORE_RUNUP_BELOW_MCAP_USD, 10000),
    minScore: num(process.env.MIN_RULE_SCORE, 55),
  },

  // --- AI evaluation ---
  ai: {
    enabled: bool(process.env.AI_ENABLED, true),
    // cli = local Claude Code CLI on your Claude subscription (no API cost); api = Anthropic API key (billed)
    backend: process.env.AI_BACKEND === 'api' ? 'api' : 'cli',
    cliPath: process.env.CLAUDE_CLI_PATH || '',
    cliSettingSources: process.env.CLAUDE_CLI_SETTING_SOURCES || 'project',
    cliTimeoutSeconds: num(process.env.AI_CLI_TIMEOUT_SECONDS, 300),
    maxConcurrent: num(process.env.AI_MAX_CONCURRENT, 2),
    // Hold back tranche-1 buys while the AI can't run (otherwise every rules-pass would be bought and never topped up).
    requireReady: bool(process.env.REQUIRE_AI_READY, true),
    model: process.env.AI_MODEL || 'claude-opus-5-5',
    effort: process.env.AI_EFFORT || 'high',
    minConfidence: num(process.env.AI_MIN_CONFIDENCE, 0.65),
  },

  // --- trading (all spend limits are hard caps) ---
  trading: {
    dryRun: bool(process.env.DRY_RUN, true),
    // A second, explicit switch so a single typo can't enable live trading.
    liveConfirm: process.env.ENABLE_LIVE_TRADING === 'I_UNDERSTAND_THE_RISK',
    // Two tranches: the first right after the hard rules pass (speed), the second only if the AI review approves.
    firstTrancheNear: num(process.env.FIRST_TRANCHE_NEAR, 2),
    secondTrancheNear: num(process.env.SECOND_TRANCHE_NEAR, 3),
    // Skip the second tranche if the price ran up more than this while the AI was thinking (no chasing).
    maxTranche2PriceRise: num(process.env.MAX_TRANCHE2_PRICE_RISE, 0.5),
    get buyAmountNear() { return this.firstTrancheNear + this.secondTrancheNear; },
    maxTotalSpendNear: num(process.env.MAX_TOTAL_SPEND_NEAR, 50),
    maxBuysPerDay: num(process.env.MAX_BUYS_PER_DAY, 10),
    minNearReserve: num(process.env.MIN_NEAR_RESERVE, 3),
    slippageBps: num(process.env.SLIPPAGE_BPS, 1000),
  },

  // --- take profit: once ROI > roi (3 = +300%), sell just enough to get withdrawNear back and hold the rest ---
  takeProfit: {
    enabled: bool(process.env.TAKE_PROFIT_ENABLED, true),
    roi: num(process.env.TAKE_PROFIT_ROI, 3),
    withdrawNear: num(process.env.TAKE_PROFIT_WITHDRAW_NEAR, 2.5),
  },
  positionCheckSeconds: num(process.env.POSITION_CHECK_SECONDS, 30),
  // What to do with the tranche-1 bag when the AI review can't run (error / timeout): 'sell' (default) or 'hold'.
  aiFailureAction: process.env.AI_FAILURE_ACTION === 'hold' ? 'hold' : 'sell',

  // --- wallet (never logged) ---
  accountId: process.env.NEAR_ACCOUNT_ID || '',
  // Some wallets export the bare base58 secret; near-api-js needs the "ed25519:" prefix.
  privateKey: ((k) => (k && !k.includes(':') ? `ed25519:${k}` : k))((process.env.NEAR_PRIVATE_KEY || '').trim()),

  dataDir: process.env.DATA_DIR || 'data',
  // Local monitor UI (bound to 127.0.0.1 only). 0 disables it.
  dashboardPort: num(process.env.DASHBOARD_PORT, 8787),
};

export const isLive = () => !config.trading.dryRun && config.trading.liveConfirm;

export function validateConfig({ needWallet }) {
  const errs = [];
  const t = config.trading;
  if (t.firstTrancheNear <= 0 || t.secondTrancheNear < 0 || t.buyAmountNear > 50) errs.push('FIRST_TRANCHE_NEAR must be > 0, SECOND_TRANCHE_NEAR >= 0, and their sum <= 50');
  if (t.maxTotalSpendNear < t.buyAmountNear) errs.push('MAX_TOTAL_SPEND_NEAR must be >= FIRST_TRANCHE_NEAR + SECOND_TRANCHE_NEAR');
  if (t.slippageBps < 10 || t.slippageBps > 5000) errs.push('SLIPPAGE_BPS must be between 10 and 5000');
  if (!t.dryRun && !t.liveConfirm) errs.push('DRY_RUN=false also requires ENABLE_LIVE_TRADING=I_UNDERSTAND_THE_RISK');
  if (needWallet) {
    if (!config.accountId) errs.push('NEAR_ACCOUNT_ID is required for trading');
    if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(config.privateKey)) errs.push('NEAR_PRIVATE_KEY must look like ed25519:<base58> (value not shown)');
  }
  return errs;
}
