// Read-only NEAR access with retries across several RPC endpoints, plus FastNEAR REST helpers.
import { config } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let rr = 0;

export async function rpc(method, params) {
  let lastErr;
  for (let i = 0; i < config.rpcUrls.length * 3; i++) {
    const url = config.rpcUrls[rr++ % config.rpcUrls.length];
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(/(^|\.)fastnear\.com$/.test(new URL(url).hostname) ? fastnearHeaders() : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await res.json();
      if (j.result !== undefined) return j.result;
      lastErr = new Error(JSON.stringify(j.error).slice(0, 200));
      // Contract-level errors (method not found, account missing) won't change on retry.
      if (!/429|rate|timeout|UNKNOWN_BLOCK|Too Many/i.test(lastErr.message)) throw lastErr;
    } catch (e) { lastErr = e; if (/MethodNotFound|does not exist|AccountDoesNotExist|UNKNOWN_ACCOUNT|CodeDoesNotExist/i.test(e.message)) throw e; }
    await sleep(600 * (i + 1));
  }
  throw lastErr;
}

export async function view(contractId, methodName, args = {}) {
  const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contractId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  const s = Buffer.from(r.result).toString();
  return s ? JSON.parse(s) : null;
}

export const viewAccount = (accountId) => rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId });

export async function ftBalance(token, accountId) {
  try { return BigInt(await view(token, 'ft_balance_of', { account_id: accountId })); } catch { return 0n; }
}

const fastnearHeaders = () => (config.fastnearApiKey ? { authorization: `Bearer ${config.fastnearApiKey}` } : {});

export async function fastnearGet(pathname) {
  for (let i = 0; i < 5; i++) {
    try { const r = await fetch(config.fastnearApiUrl + pathname, { headers: fastnearHeaders() }); if (r.ok) return r.json(); } catch {}
    await sleep(1000 * (i + 1));
  }
  return null;
}

export async function txIndexer(pathname, body) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(config.txIndexerUrl + pathname, { method: 'POST', headers: { 'content-type': 'application/json', ...fastnearHeaders() }, body: JSON.stringify(body) });
      if (r.ok) return r.json();
    } catch {}
    await sleep(1200 * (i + 1));
  }
  throw new Error(`tx indexer ${pathname} failed`);
}

export const yoctoToNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
export const nearToYocto = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 18n;
