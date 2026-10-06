// What a transaction actually delivered, read from its receipt logs.
// Comparing balances right after sending is unreliable: signAndSendTransaction returns at EXECUTED_OPTIMISTIC
// while view calls read the `final` state 2-3 blocks behind, so the balance often hasn't moved yet.
import { ftBalance } from '../near/rpc.js';

/** Sum of `token` credited to `account` in one receipt's logs (NEP-141 events, or wrap.near's plain "Transfer" logs). */
function creditedInLogs(logs, account) {
  let fromEvents = 0n, fromText = 0n, sawEvent = false;
  for (const l of logs || []) {
    if (l.startsWith('EVENT_JSON:')) {
      try {
        const e = JSON.parse(l.slice(11));
        if (e.standard === 'nep141' && e.event === 'ft_transfer') {
          sawEvent = true;
          for (const d of e.data || []) if (d.new_owner_id === account) fromEvents += BigInt(d.amount);
        }
      } catch {}
    } else {
      const m = l.match(/^Transfer (\d+) from (\S+) to (\S+)$/);
      if (m && m[3] === account) fromText += BigInt(m[1]);
    }
  }
  return sawEvent ? fromEvents : fromText; // a contract emitting both formats would otherwise be counted twice
}

/** Amount of `token` credited to `account` by a send result (FinalExecutionOutcome from near-api-js). */
export function receivedFromOutcome(res, token, account) {
  let total = 0n;
  for (const r of res?.receipts_outcome || []) if (r.outcome?.executor_id === token) total += creditedInLogs(r.outcome.logs, account);
  return total;
}

/** Same, for a transaction decoded by near/indexer.js (used to reconcile past sales). */
export function receivedFromDecodedTx(tx, token, account) {
  const byReceipt = new Map();
  for (const l of tx.logs || []) if (l.executor === token) byReceipt.set('all', [...(byReceipt.get('all') || []), l.text]);
  let total = creditedInLogs(byReceipt.get('all'), account);
  if (total === 0n) for (const e of tx.events || []) if (e.executor === token && e.standard === 'nep141' && e.event === 'ft_transfer') for (const d of e.data || []) if (d.new_owner_id === account) total += BigInt(d.amount);
  return total;
}

/** Fallback when logs show nothing: wait (up to `ms`) for the balance to move past `before`. */
export async function waitForBalanceIncrease(token, account, before, ms = 12000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const now = await ftBalance(token, account);
    if (now > before) return now - before;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 0n;
}

/** Amount received: from the logs, else by watching the balance. */
export async function amountReceived(res, token, account, before) {
  const fromLogs = receivedFromOutcome(res, token, account);
  return fromLogs > 0n ? fromLogs : waitForBalanceIncrease(token, account, before);
}
