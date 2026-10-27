"use client";

import { seedDb, type MockDb } from "./seed";

/** Browser-only persistence for the mock database, so the demo flows survive reloads and sync across tabs. */
const KEY = "nc-mock-db-v1"; // key kept; the `v` field inside decides whether a stored copy is still usable

export function loadDb(): MockDb {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb;
      if (parsed.v === 5) return parsed;
    }
  } catch {
    /* fall through to a fresh seed */
  }
  const fresh = seedDb();
  saveDb(fresh);
  return fresh;
}

export function saveDb(db: MockDb): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    /* storage full or blocked: demo state just will not persist */
  }
}

/** Load, change, save. Returns whatever the change function returns. */
export function mutateDb<T>(fn: (db: MockDb) => T): T {
  const db = loadDb();
  const result = fn(db);
  db.updatedAt = new Date().toISOString();
  saveDb(db);
  return result;
}

export function resetDb(): void {
  saveDb(seedDb());
}

/** Calls back when another tab changes the mock db (the mock stand-in for a Realtime event). */
export function onDbChange(cb: () => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/**
 * Table ordering (2.0.0): load, run, and save ONLY when the table state really changed (its version moved). Polls
 * (occupancy, the guest view, the staff board) then write nothing, so two open tabs do not wake each other up through
 * the storage event on every poll.
 */
export function mutateTablesDb<T>(fn: (db: MockDb) => T): T {
  const db = loadDb();
  const key = () => `${db.tables.version}|${db.tables.alertSeq}|${db.settings.tableOrdering}`;
  const before = key();
  const result = fn(db);
  if (key() !== before) {
    db.updatedAt = new Date().toISOString();
    saveDb(db);
  }
  return result;
}
