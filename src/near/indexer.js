// Follows new transactions of an account through the FastNEAR transaction indexer and returns decoded txs.
import { txIndexer } from './rpc.js';

/** Fetch full transactions (with receipts and logs) for up to N hashes, 20 per request. */
export async function fetchTxs(hashes) {
  hashes = [...new Set(hashes)]; // the account index can list a tx more than once
  const out = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const j = await txIndexer('/v0/transactions', { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of j.transactions || []) { const d = decodeTx(t); if (!out.some((x) => x.hash === d.hash)) out.push(d); } // the indexer can return a tx twice
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Normalise a FastNEAR transaction: signer, receiver, methods+args, and every EVENT_JSON / plain log with its executor. */
export function decodeTx(t) {
  const tx = t.transaction;
  const calls = [];
  for (const a of tx.actions) {
    const fc = a.FunctionCall || a.Delegate?.delegate_action?.actions?.find((x) => x.FunctionCall)?.FunctionCall;
    if (fc) { let args = null; try { args = JSON.parse(Buffer.from(fc.args, 'base64').toString()); } catch {} calls.push({ method: fc.method_name, args, deposit: fc.deposit }); }
  }
  const events = [], logs = [];
  let failed = false;
  for (const r of t.receipts) {
    const o = r.execution_outcome.outcome;
    if (o.status && o.status.Failure) failed = true;
    for (const l of o.logs) {
      if (l.startsWith('EVENT_JSON:')) { try { events.push({ executor: o.executor_id, ...JSON.parse(l.slice(11)) }); } catch {} }
      else logs.push({ executor: o.executor_id, text: l });
    }
  }
  return { hash: tx.hash, signer: tx.signer_id, receiver: tx.receiver_id, ts: Number(String(t.execution_outcome.block_timestamp).slice(0, 13)), height: t.execution_outcome.block_height, calls, events, logs, failed };
}

/**
 * New tx hashes of `accountId` since `sinceHeight` (exclusive), oldest first.
 * The indexer returns newest-first pages; we page back until we pass the cursor.
 */
export async function newTxHashes(accountId, sinceHeight, maxPages = 10) {
  const hashes = [];
  let resume, head = sinceHeight;
  for (let p = 0; p < maxPages; p++) {
    const j = await txIndexer('/v0/account', { account_id: accountId, resume_token: resume });
    const rows = j.account_txs || [];
    for (const r of rows) {
      head = Math.max(head, r.tx_block_height);
      if (r.tx_block_height > sinceHeight) hashes.push(r.transaction_hash);
    }
    if (!j.resume_token || !rows.length || rows[rows.length - 1].tx_block_height <= sinceHeight || sinceHeight === 0) break;
    resume = j.resume_token;
  }
  return { hashes: [...new Set(hashes)].reverse(), head };
}

/** All tx hashes of an account (bounded), used for per-token early-trade analysis and wallet profiling. */
export async function accountTxHashes(accountId, maxPages = 5) {
  const rows = [];
  let resume, count;
  for (let p = 0; p < maxPages; p++) {
    const j = await txIndexer('/v0/account', { account_id: accountId, resume_token: resume });
    count = count ?? j.txs_count;
    rows.push(...(j.account_txs || []));
    if (!j.resume_token || !(j.account_txs || []).length) break;
    resume = j.resume_token;
  }
  return { rows, count: count ?? rows.length, complete: rows.length >= (count ?? 0) };
}
