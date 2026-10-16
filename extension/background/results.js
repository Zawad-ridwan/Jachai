import { STORAGE_KEYS } from '../shared/config.js';

// Recent analysis results live in chrome.storage.session: kept in memory only,
// wiped when Chrome closes, and unreadable by content scripts in web pages.
// The popup watches this key to update live.

const KEY = STORAGE_KEYS.RESULTS;
const MAX_RESULTS = 50; // room for 5 images, each with up to 5 checks on its text

// Every change goes through one queue, so two analyses finishing at the
// same moment can't overwrite each other's updates.
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

async function read() {
  const { [KEY]: list } = await chrome.storage.session.get(KEY);
  return Array.isArray(list) ? list : [];
}

export async function getResult(id) {
  return (await read()).find((e) => e.id === id) ?? null;
}

export function addResult(fields) {
  return serial(async () => {
    const entry = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...fields };
    const list = [entry, ...(await read())].slice(0, MAX_RESULTS);
    await chrome.storage.session.set({ [KEY]: list });
    return entry;
  });
}

export function updateResult(id, patch) {
  return serial(async () => {
    const list = await read();
    const i = list.findIndex((e) => e.id === id);
    if (i === -1) return null;
    list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
    await chrome.storage.session.set({ [KEY]: list });
    return list[i];
  });
}

export function clearResults() {
  return serial(() => chrome.storage.session.remove(KEY));
}