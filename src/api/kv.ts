// App-scoped KV store access (Workflow 3 credential storage).
//
// Per AGENTS.md, the app must NOT use browser storage for app data — the sandboxed
// iframe makes it unreliable. The platform provides an encrypted, app-scoped KV store
// reached through CRIBL_API_URL (`/kvstore/...`); the fetch proxy rewrites these to
// `/a/{appId}/kvstore/...` so values never leak across apps. Those app-scoped paths
// are granted automatically, so they are NOT declared in config/policies.yml.
//
// We store the Cribl.Cloud API Credential and the short-lived OAuth token here. The
// token key is also referenced from config/proxies.yml so the platform can inject it
// as a Bearer header on cross-workspace requests (the proxy strips any Authorization
// header we set ourselves).
import { ApiError, apiRequest } from './client';

/**
 * Flat KV keys. These are top-level so config/proxies.yml can reference the token
 * via `kv.packCopyToken` in its header-injection expression.
 */
export const KV_KEYS = {
  orgId: 'packCopyOrgId',
  clientId: 'packCopyClientId',
  clientSecret: 'packCopyClientSecret',
  token: 'packCopyToken',
  tokenExpiresAt: 'packCopyTokenExpiresAt',
} as const;

function kvPath(key: string): string {
  return `/kvstore/${encodeURIComponent(key)}`;
}

/** Wrap a KV failure with the operation + key + status so it isn't a bare "bad request". */
function kvError(op: string, key: string, err: unknown): Error {
  if (err instanceof ApiError) {
    return new ApiError(`KV ${op} "${key}" failed (${err.status}): ${err.message}`, err.status);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Read a KV value, or undefined when the key is absent (or stored empty).
 *
 * Values are stored and returned as raw strings — see kvSet. Callers that need a
 * number/boolean parse the string themselves.
 */
export async function kvGet(key: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return await apiRequest<string>(kvPath(key), { signal, rawResponse: true });
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return undefined;
    throw kvError('get', key, err);
  }
}

/**
 * Write a KV value as a raw string. The store treats values as opaque text (so the
 * token round-trips cleanly into the `kv.packCopyToken` header injection); JSON-
 * encoding a scalar here would be rejected 400 by the store's body parser.
 */
export async function kvSet(key: string, value: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiRequest(kvPath(key), { method: 'PUT', body: value, rawBody: true, signal });
  } catch (err) {
    throw kvError('set', key, err);
  }
}

/**
 * Delete a KV key. Best-effort: an already-absent key can surface as 404 or 400
 * depending on the store, and a failed cleanup must not break the caller.
 */
export async function kvDelete(key: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiRequest(kvPath(key), { method: 'DELETE', signal });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return;
    throw kvError('delete', key, err);
  }
}
