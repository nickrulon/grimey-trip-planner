// One API layer for the whole app: every write carries the trip key, every
// call reports into a single sync-status store, and failures degrade to an
// honest "offline / locked" state instead of a silent nothing.

export type SyncState = 'synced' | 'saving' | 'offline' | 'locked' | 'idle';

const TRIP_KEY = 'grimey-trip-key';
const DEVICE_KEY = 'grimey-device-label';

export function getTripKey(): string {
  try { return localStorage.getItem(TRIP_KEY) ?? ''; } catch { return ''; }
}
export function setTripKey(k: string) {
  try { localStorage.setItem(TRIP_KEY, k.trim()); } catch { /* private mode */ }
}
export function deviceLabel(): string {
  try {
    let l = localStorage.getItem(DEVICE_KEY);
    if (!l) {
      l = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) ? 'phone' : 'laptop';
      localStorage.setItem(DEVICE_KEY, l);
    }
    return l;
  } catch { return 'device'; }
}

// ---- sync status store (tiny pub/sub; React components subscribe) ----------
export interface SyncStatus { state: SyncState; at: string | null; detail?: string }
let status: SyncStatus = { state: 'idle', at: null };
const listeners = new Set<(s: SyncStatus) => void>();

export function onSync(fn: (s: SyncStatus) => void): () => void {
  listeners.add(fn);
  fn(status);
  return () => { listeners.delete(fn); };
}
function setStatus(s: SyncStatus) {
  status = s;
  for (const fn of listeners) fn(s);
}
export function syncStatus() { return status; }

// ---- fetch helpers ----------------------------------------------------------
export async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

/** A plan write: keyed, and reflected in the shared sync status. */
export async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  setStatus({ state: 'saving', at: status.at });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-trip-key': getTripKey() },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      setStatus({ state: 'locked', at: status.at });
      throw new Error((data as { error?: string }).error ?? 'Enter the trip key to save from this device.');
    }
    if (!res.ok) {
      setStatus({ state: 'synced', at: status.at });
      throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    setStatus({ state: 'synced', at: new Date().toISOString() });
    return data as T;
  } catch (err) {
    if ((err as Error).message?.startsWith('Enter the trip key')) throw err;
    if (err instanceof TypeError) {
      // network failure — the change did NOT save
      setStatus({ state: 'offline', at: status.at });
      throw new Error('Offline — that change did not save. Retry when you have signal.');
    }
    throw err;
  }
}
