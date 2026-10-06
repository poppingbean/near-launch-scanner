// AI quality/risk review with Claude. Called only for tokens that already passed the deterministic gates.
// Two backends (AI_BACKEND):
//   cli (default) - runs the locally installed Claude Code CLI (`claude -p`) on your Claude subscription login,
//                   so reviews cost no API credits. Log in once with `claude` → /login.
//   api           - Anthropic API with ANTHROPIC_API_KEY (billed per token).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

const SYSTEM = () => `You review brand-new memecoins on NEAR for a small, automated buyer that spends a fixed amount per token.
You receive on-chain features collected a few minutes after the token's liquidity went live.
A small starter position (${config.trading.firstTrancheNear} NEAR) was already bought the moment the token passed the hard rules, so your job is to decide what to do with it:
- BUY_MORE: add ${config.trading.secondTrancheNear} NEAR. Only when the evidence is clearly good: real demand from independent wallets, no sign of coordination or creator extraction.
- HOLD: keep the starter position, add nothing. Decent but unproven: no red flags that point to coordination, extraction or a trap, and the upside is plausible, but not strong enough to add.
- SELL: exit the starter position now. Evidence of coordination, creator extraction, a trap (non-standard contract, abnormal tax), or demand already fading (buyers exiting, net selling).
Set confidence for the action you recommend.

What past investigations on these launchpads showed (use it, don't recite it):
- nearly.trade / justhoot launch single-sided: the pool starts with tokens only, so NEAR in the pool comes from buyers.
- Pools may be quoted in wNEAR, NEARLY or RHEA; all NEAR amounts in the features are already converted to NEAR.
- We buy in the first minutes after liquidity goes live. At that stage a few early buyers holding a large share of supply is normal and an accepted risk: do not SKIP for buyer or holder concentration alone. What matters is whether those buyers are coordinated with each other or the creator (shared non-exchange funders, creator-funded wallets, hand-offs to fresh wallets).
- features.market.mcapUsd is the fully diluted market cap in USD. Below ${config.rules.ignoreRunupBelowMcapUsd.toLocaleString('en-US')} USD the token is still early: a 2-3x (or larger) rise since the first trade is fine and must not count against it.
- Coordinated groups split one position across fresh wallets funded by one source, or move tokens to fresh wallets before selling ("hand-offs").
- Creators of real projects usually keep their allocation; a creator selling early or funding buyers is a strong negative.
- A non-standard token contract (code hash different from the launchpad template) was a honeypot that erased buyers' balances.
- Funding through exchanges or NEAR Intents is normal and is not evidence of a link by itself.
- Above ${config.rules.ignoreRunupBelowMcapUsd.toLocaleString('en-US')} USD market cap, a price many multiples above the first trade usually means the buyer is late exit liquidity.

Be strict about coordination and creator extraction: recommend SELL when there is evidence of either. Small, concentrated early demand is acceptable.`;

const SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['BUY_MORE', 'HOLD', 'SELL'], description: 'what to do with the starter position we already hold' },
    confidence: { type: 'number', description: '0 to 1, confidence in the recommended action' },
    quality_score: { type: 'integer', description: '0 to 100' },
    risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'extreme'] },
    reasons: { type: 'array', items: { type: 'string' } },
    red_flags: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'confidence', 'quality_score', 'risk_level', 'reasons', 'red_flags'],
  additionalProperties: false,
};

const userPrompt = (features, ruleResult) =>
  `Rule engine: score ${ruleResult.score}/100, all gates passed.\n\nFeatures:\n${JSON.stringify(features, null, 1)}`;

// ---------------------------------------------------------------- local Claude Code CLI

/**
 * Path of the claude executable: the newest of the npm-installed CLI and the one bundled with the Claude desktop app
 * (%APPDATA%\Claude\claude-code\<version>\<id>\claude.exe, kept up to date by the app). New models need recent versions.
 */
let resolvedExe = null;
function claudeExecutable() {
  if (config.ai.cliPath) return config.ai.cliPath;
  if (resolvedExe) return resolvedExe;
  if (process.platform !== 'win32') return (resolvedExe = 'claude');
  const appData = process.env.APPDATA || '';
  const candidates = [path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')];
  const desktopDir = path.join(appData, 'Claude', 'claude-code');
  if (fs.existsSync(desktopDir)) for (const v of fs.readdirSync(desktopDir)) {
    const vDir = path.join(desktopDir, v);
    if (fs.statSync(vDir).isDirectory()) for (const id of fs.readdirSync(vDir)) candidates.push(path.join(vDir, id, 'claude.exe'));
  }
  const versioned = candidates.filter((c) => fs.existsSync(c)).map((exe) => {
    const out = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: cliEnv() }).stdout || '';
    return { exe, v: (out.match(/(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number) };
  }).filter((c) => c.v.length === 3);
  if (!versioned.length) throw new Error('claude.exe not found; install Claude Code (npm i -g @anthropic-ai/claude-code) or set CLAUDE_CLI_PATH');
  versioned.sort((a, b) => b.v[0] - a.v[0] || b.v[1] - a.v[1] || b.v[2] - a.v[2]);
  return (resolvedExe = versioned[0].exe);
}
export const claudeCliInfo = () => { try { return claudeExecutable(); } catch (e) { return `not found: ${e.message}`; } };

// Inherited CLAUDE*/ANTHROPIC* variables (e.g. when the scanner is started from inside another Claude session, or an
// API key in .env) would override the CLI's own login — and an API key would be billed. Strip them all.
function cliEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/i.test(k)) env[k] = v;
  return env;
}

// The CLI is heavy; cap parallel reviews (they run in the background while scanning continues).
let running = 0; const queue = [];
const acquire = () => new Promise((res) => (running < config.ai.maxConcurrent ? (running++, res()) : queue.push(res)));
const release = () => { const next = queue.shift(); if (next) next(); else running--; };

function runCli(prompt) {
  const args = [
    '-p', '--output-format', 'json',
    '--model', config.ai.model, '--effort', config.ai.effort,
    '--tools', '',                      // pure analysis: no file / shell / web tools
    '--no-session-persistence', '--strict-mcp-config',
    // Only load project settings (none exist in the temp cwd) so a provider override in ~/.claude/settings.json
    // (e.g. a third-party ANTHROPIC_BASE_URL) doesn't hijack the review. Set CLAUDE_CLI_SETTING_SOURCES=user to allow it.
    '--setting-sources', config.ai.cliSettingSources,
    '--system-prompt', SYSTEM(),
    '--json-schema', JSON.stringify(SCHEMA),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(claudeExecutable(), args, { cwd: os.tmpdir(), env: cliEnv(), windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude CLI timed out after ${config.ai.cliTimeoutSeconds}s`)); }, config.ai.cliTimeoutSeconds * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return reject(new Error(`claude CLI exited ${code}: ${(err || out).trim().slice(0, 300)}`));
      try { resolve(JSON.parse(line)); } catch (e) { reject(new Error(`claude CLI returned unparsable output: ${line.slice(0, 200)}`)); }
    });
    child.stdin.end(prompt);
  });
}

/** Pull the review object out of the CLI result (structured output, or JSON inside the text as a fallback). */
function parseReview(r) {
  if (r.structured_output && typeof r.structured_output === 'object') return r.structured_output;
  const text = String(r.result || '');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`no JSON in claude CLI result: ${text.slice(0, 200)}`);
  return JSON.parse(m[0]);
}

async function cliReview(features, ruleResult) {
  await acquire();
  try {
    const r = await runCli(userPrompt(features, ruleResult));
    if (r.is_error) {
      const msg = String(r.result || r.subtype || 'unknown error');
      const hint = /authenticate|OAuth|log ?in/i.test(msg) ? ' → run `claude` in a terminal and use /login' : '';
      throw new Error(`claude CLI: ${msg.slice(0, 200)}${hint}`);
    }
    const out = parseReview(r);
    return { ...out, model: Object.keys(r.modelUsage || {})[0] || config.ai.model, backend: 'cli', durationMs: r.duration_ms };
  } finally { release(); }
}

// ---------------------------------------------------------------- Anthropic API (optional, billed)

let client = null;
async function apiReview(features, ruleResult) {
  if (!client) { const { default: Anthropic } = await import('@anthropic-ai/sdk'); client = new Anthropic(); }
  const response = await client.beta.messages.create({
    model: config.ai.model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM(),
    messages: [{ role: 'user', content: userPrompt(features, ruleResult) }],
  });
  if (response.stop_reason === 'refusal') return { action: 'SELL', confidence: 0, quality_score: 0, risk_level: 'extreme', reasons: ['model declined to review'], red_flags: [], model: response.model, backend: 'api' };
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { ...JSON.parse(text), model: response.model, backend: 'api', usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
}

/** Whether reviews can run right now. `claude auth status` reports logged-in even with an expired token, so probe for real. */
export const aiStatus = { ok: null, error: null, checkedTs: null, backend: config.ai.backend };
let probing = null;
export function checkAi() {
  if (!config.ai.enabled) return Promise.resolve(Object.assign(aiStatus, { ok: false, error: 'AI disabled', checkedTs: Date.now() }));
  probing ??= (async () => {
    try {
      if (config.ai.backend === 'api') { if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is empty'); }
      else {
        await acquire();
        try {
          const r = await runCli('Health check, no token to review. Return action HOLD, confidence 0, quality_score 0, risk_level low, empty reasons and red_flags.');
          if (r.is_error) throw new Error(String(r.result || r.subtype).slice(0, 200) + (/authenticate|OAuth|log ?in/i.test(String(r.result)) ? ' → run `claude` in a terminal and use /login' : ''));
          parseReview(r);
        } finally { release(); }
      }
      Object.assign(aiStatus, { ok: true, error: null });
    } catch (e) { Object.assign(aiStatus, { ok: false, error: e.message }); }
    aiStatus.checkedTs = Date.now();
    probing = null;
    return aiStatus;
  })();
  return probing;
}

export async function aiReview(features, ruleResult) {
  try {
    const r = config.ai.backend === 'api' ? await apiReview(features, ruleResult) : await cliReview(features, ruleResult);
    r.decision = r.action === 'BUY_MORE' ? 'BUY' : 'SKIP'; // legacy field for older views
    Object.assign(aiStatus, { ok: true, error: null, checkedTs: Date.now() });
    return r;
  } catch (e) {
    Object.assign(aiStatus, { ok: false, error: e.message, checkedTs: Date.now() });
    throw e;
  }
}
