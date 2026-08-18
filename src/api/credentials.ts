// Cribl.Cloud API Credential + OAuth token management (Workflow 3).
//
// Cross-workspace calls reach the management plane (gateway.cribl.cloud) and other
// workspaces' Leaders, which are OUTSIDE the current-workspace API the platform auto-
// authenticates. They require an organization-level Bearer token, obtained from the
// Cribl.Cloud OAuth endpoint with a client-credentials grant.
//
// The user supplies an Organization API Credential (Client ID + Secret); we store it
// encrypted in the app KV store and exchange it for a 24h token, caching the token in
// KV. config/proxies.yml injects `kv.packCopyToken` as the Bearer header on outbound
// requests (the proxy strips any Authorization header we set directly), so JS only has
// to guarantee a fresh token is written to KV before each cross-workspace call.
//
// SECURITY: this credential grants org-wide API access and lives in an app-scoped
// (not per-user) KV store. The UI warns the user to use a dedicated least-privilege
// credential and to clear it (and disable/delete it in Cribl.Cloud) when finished.
import { KV_KEYS, kvDelete, kvGet, kvSet } from './kv';

/** Cribl.Cloud OAuth token endpoint (client-credentials grant). */
const TOKEN_URL = 'https://login.cribl.cloud/oauth/token';
/** Audience for the management-plane API, per the Cribl.Cloud auth docs. */
const TOKEN_AUDIENCE = 'https://api.cribl.cloud';
/** Refresh the token this many ms before it actually expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface StoredCredential {
  orgId: string;
  clientId: string;
  clientSecret: string;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when an API Credential (org id + client id/secret) is stored. */
export async function hasStoredCredential(signal?: AbortSignal): Promise<boolean> {
  const [orgId, clientId, clientSecret] = await Promise.all([
    kvGet(KV_KEYS.orgId, signal),
    kvGet(KV_KEYS.clientId, signal),
    kvGet(KV_KEYS.clientSecret, signal),
  ]);
  return Boolean(orgId && clientId && clientSecret);
}

/** Read the stored organization id (needed to list workspaces), or undefined. */
export async function getStoredOrgId(signal?: AbortSignal): Promise<string | undefined> {
  return kvGet(KV_KEYS.orgId, signal);
}

/** Persist the API Credential. Any previously cached token is invalidated. */
export async function saveCredential(cred: StoredCredential, signal?: AbortSignal): Promise<void> {
  // Invalidate any cached token by writing an expired tombstone rather than DELETE:
  // on a first-ever save those token keys don't exist yet, and a delete of a missing
  // key can come back as 400. A blank token / expiry 0 forces ensureToken() to refresh.
  await Promise.all([
    kvSet(KV_KEYS.orgId, cred.orgId.trim(), signal),
    kvSet(KV_KEYS.clientId, cred.clientId.trim(), signal),
    kvSet(KV_KEYS.clientSecret, cred.clientSecret, signal),
    kvSet(KV_KEYS.token, '', signal),
    kvSet(KV_KEYS.tokenExpiresAt, '0', signal),
  ]);
}

/** Remove the stored API Credential and any cached token from the KV store. */
export async function clearCredential(signal?: AbortSignal): Promise<void> {
  await Promise.all([
    kvDelete(KV_KEYS.orgId, signal),
    kvDelete(KV_KEYS.clientId, signal),
    kvDelete(KV_KEYS.clientSecret, signal),
    kvDelete(KV_KEYS.token, signal),
    kvDelete(KV_KEYS.tokenExpiresAt, signal),
  ]);
}

/**
 * Exchange the stored client credentials for a fresh OAuth token and cache it in KV.
 * The client secret is read from KV and sent in the request body (the proxy injects
 * only headers, so this is the only place the secret is momentarily in memory).
 */
async function refreshToken(signal?: AbortSignal): Promise<void> {
  const [clientId, clientSecret] = await Promise.all([
    kvGet(KV_KEYS.clientId, signal),
    kvGet(KV_KEYS.clientSecret, signal),
  ]);
  if (!clientId || !clientSecret) {
    throw new Error('No API Credential is configured. Set one up before copying packs.');
  }

  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience: TOKEN_AUDIENCE,
      }),
      signal,
    });
  } catch (err) {
    throw new Error(`Could not reach the Cribl.Cloud token endpoint: ${toMessage(err)}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Token request failed (${res.status}). Check the Client ID/Secret and the credential's permissions.${
        text ? ` ${text.slice(0, 300)}` : ''
      }`,
    );
  }

  const data = (await res.json()) as TokenResponse;
  if (!data.access_token) throw new Error('Token endpoint returned no access_token.');
  const ttlMs = (data.expires_in ?? 3600) * 1000;
  const expiresAt = Date.now() + ttlMs - EXPIRY_MARGIN_MS;
  await Promise.all([
    kvSet(KV_KEYS.token, data.access_token, signal),
    kvSet(KV_KEYS.tokenExpiresAt, String(expiresAt), signal),
  ]);
}

/**
 * Guarantee a valid, unexpired token is present in KV before a cross-workspace call.
 * The token itself is not returned — the platform proxy injects it from KV per
 * config/proxies.yml. Re-exchanges the credential when the cached token is missing
 * or near expiry.
 */
export async function ensureToken(signal?: AbortSignal): Promise<void> {
  const [token, expiresAtRaw] = await Promise.all([
    kvGet(KV_KEYS.token, signal),
    kvGet(KV_KEYS.tokenExpiresAt, signal),
  ]);
  const expiresAt = Number(expiresAtRaw);
  const valid = token && Number.isFinite(expiresAt) && expiresAt > 0 && Date.now() < expiresAt;
  if (!valid) await refreshToken(signal);
}
