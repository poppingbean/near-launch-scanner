// Console + JSONL event log. Any string that looks like a NEAR private key is redacted before writing.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const file = path.join(config.dataDir, 'events.jsonl');
const redact = (s) => String(s).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{40,}/g, 'ed25519:[REDACTED]');

// Last 500 log entries kept in memory for the monitor UI.
export const recentLogs = [];
let seq = 0;

export function log(level, msg, data) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  console.log(redact(line) + (data ? ' ' + redact(JSON.stringify(data)) : ''));
  const entry = JSON.parse(redact(JSON.stringify({ id: ++seq, ts: Date.now(), level, msg, data })));
  recentLogs.push(entry); if (recentLogs.length > 500) recentLogs.shift();
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}
export const info = (m, d) => log('INFO', m, d);
export const warn = (m, d) => log('WARN', m, d);
export const error = (m, d) => log('ERROR', m, d);
