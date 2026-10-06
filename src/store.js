// Tiny JSON-file persistence: tokens, scan cursors, code-hash templates, positions and spend.
import fs from 'node:fs';
import path from 'node:path';
import { config, isLive } from './config.js';

const file = path.join(config.dataDir, 'state.json');
const empty = () => ({ cursors: {}, tokens: {}, templates: {}, positions: [], spend: [] });

export const state = fs.existsSync(file) ? { ...empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty();

let dirty = false;
export const markDirty = () => { dirty = true; };
export function save() {
  if (!dirty) return;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, file);
  dirty = false;
}

export function upsertToken(key, patch) {
  const t = state.tokens[key] || (state.tokens[key] = { key, firstSeen: Date.now(), status: 'detected', history: [] });
  Object.assign(t, patch);
  markDirty();
  return t;
}

// Re-key a meme.cooking raise ("meme#123") to its real token id once the token is deployed.
export function rekeyToken(oldKey, newKey) {
  if (!state.tokens[oldKey] || oldKey === newKey) return state.tokens[newKey];
  state.tokens[newKey] = { ...state.tokens[oldKey], key: newKey };
  delete state.tokens[oldKey];
  markDirty();
  return state.tokens[newKey];
}

// Dry-run fills are kept as "paper" entries so the strategy can be watched; caps only count the current mode's book.
const inMode = (x) => !!x.paper === !isLive();
export const spentNear = () => state.spend.filter(inMode).reduce((s, x) => s + x.near, 0);
// Daily cap counts tokens entered (tranche 1); tranche-2 top-ups don't use a slot.
export const buysToday = () => state.spend.filter((x) => inMode(x) && Date.now() - x.ts < 86400e3 && x.tranche !== 2).length;
export const findPosition = (token) => state.positions.find((p) => p.token === token && inMode(p));
export const openPositions = () => state.positions.filter(inMode);
