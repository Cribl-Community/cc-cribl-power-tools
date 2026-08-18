// Cross-workspace API access (Workflow 3 copy DESTINATION).
//
// Two external hosts are involved, both declared in config/proxies.yml and both
// authenticated with the org Bearer token that the proxy injects from KV (see
// credentials.ts):
//   - gateway.cribl.cloud       — the management plane; lists the org's workspaces.
//   - <workspace leaderFQDN>     — a specific workspace's Leader API (packs, commit,
//                                  deploy), reached at https://<leaderFQDN>/api/v1.
//
// We call ensureToken() before every request so a fresh Bearer is in KV for the proxy
// to inject (the proxy strips any Authorization header we set ourselves).
import { ApiError, extractError } from './client';
import { ensureToken } from './credentials';
import {
  type Counted,
  type GitCommitSummary,
  type PackInfo,
  type PackInstallBody,
  type UploadPackResponse,
  type WorkspaceInfo,
  type WorkspacesListResponse,
} from './types';

/** Management-plane base (lists workspaces in an organization). */
const GATEWAY_BASE = 'https://gateway.cribl.cloud';

const PAGE_SIZE = 200;

interface MpOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** JSON request body (mutually exclusive with `binaryBody`). */
  jsonBody?: unknown;
  /** Raw bytes for octet-stream uploads (mutually exclusive with `jsonBody`). */
  binaryBody?: ArrayBuffer;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /** 'none' for endpoints with no/!ignored response body (e.g. deploy). */
  responseType?: 'json' | 'none';
}

/**
 * Request against an external Cribl host (gateway or a workspace Leader). The Bearer
 * token is injected by the platform proxy from KV, so it is refreshed here first but
 * never attached to the request directly.
 */
async function mpRequest<T>(url: string, opts: MpOptions = {}): Promise<T> {
  const { method = 'GET', jsonBody, binaryBody, query, signal, responseType = 'json' } = opts;
  await ensureToken(signal);

  let finalUrl = url;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) finalUrl += (finalUrl.includes('?') ? '&' : '?') + s;
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  let body: BodyInit | undefined;
  if (binaryBody !== undefined) {
    headers['Content-Type'] = 'application/octet-stream';
    body = binaryBody;
  } else if (jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(jsonBody);
  }

  const res = await fetch(finalUrl, { method, headers, body, signal });
  if (!res.ok) throw new ApiError(await extractError(res), res.status);
  if (responseType === 'none' || res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Base URL of a workspace's Leader API. */
function workspaceBase(leaderFQDN: string): string {
  return `https://${leaderFQDN.replace(/\/$/, '')}/api/v1`;
}

/** Worker-group-context path within a workspace Leader (/m/:gid/...). */
function groupPath(gid: string, path = ''): string {
  return `/m/${encodeURIComponent(gid)}${path}`;
}

/**
 * List all Workspaces in the organization
 * (GET gateway /v1/organizations/{orgId}/workspaces).
 */
export async function listWorkspaces(
  orgId: string,
  signal?: AbortSignal,
): Promise<WorkspaceInfo[]> {
  const res = await mpRequest<WorkspacesListResponse>(
    `${GATEWAY_BASE}/v1/organizations/${encodeURIComponent(orgId)}/workspaces`,
    { signal },
  );
  return res?.items ?? [];
}

/** List the Stream worker groups of another workspace (GET .../master/groups). */
export async function listWorkspaceGroups(
  leaderFQDN: string,
  signal?: AbortSignal,
): Promise<{ id: string; name?: string; description?: string }[]> {
  const base = workspaceBase(leaderFQDN);
  const all: { id: string; name?: string; description?: string }[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await mpRequest<Counted<{ id: string; name?: string; description?: string }>>(
      `${base}/master/groups`,
      { query: { product: 'stream', offset, limit: PAGE_SIZE }, signal },
    );
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

/** List the Packs installed in a worker group of another workspace (for conflicts). */
export async function listWorkspacePacks(
  leaderFQDN: string,
  gid: string,
  signal?: AbortSignal,
): Promise<PackInfo[]> {
  const base = workspaceBase(leaderFQDN);
  const all: PackInfo[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await mpRequest<Counted<PackInfo>>(`${base}${groupPath(gid, '/packs')}`, {
      query: { offset, limit: PAGE_SIZE },
      signal,
    });
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

/**
 * Upload exported Pack bytes to a destination workspace's staging area
 * (PUT .../packs?filename=...) and return the staging source id for install.
 */
export async function uploadPackFile(
  leaderFQDN: string,
  gid: string,
  filename: string,
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<string> {
  const base = workspaceBase(leaderFQDN);
  const res = await mpRequest<UploadPackResponse>(`${base}${groupPath(gid, '/packs')}`, {
    method: 'PUT',
    query: { filename },
    binaryBody: bytes,
    signal,
  });
  if (!res?.source) throw new Error('Upload did not return a staging source id.');
  return res.source;
}

/** Install a staged Pack into a destination worker group (POST .../packs). */
export async function installPack(
  leaderFQDN: string,
  gid: string,
  body: PackInstallBody,
  signal?: AbortSignal,
): Promise<void> {
  const base = workspaceBase(leaderFQDN);
  await mpRequest(`${base}${groupPath(gid, '/packs')}`, { method: 'POST', jsonBody: body, signal });
}

/**
 * Commit a destination worker group's pending changes (POST .../version/commit).
 * Returns the new commit hash, or undefined when there was nothing to commit.
 */
export async function commitWorkspaceGroup(
  leaderFQDN: string,
  gid: string,
  message: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const base = workspaceBase(leaderFQDN);
  const res = await mpRequest<Counted<GitCommitSummary>>(
    `${base}${groupPath(gid, '/version/commit')}`,
    { method: 'POST', jsonBody: { message }, signal },
  );
  return res?.items?.[0]?.commit;
}

/** Deploy a committed version to a destination worker group (PATCH .../deploy). */
export async function deployWorkspaceGroup(
  leaderFQDN: string,
  gid: string,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  const base = workspaceBase(leaderFQDN);
  await mpRequest(`${base}/master/groups/${encodeURIComponent(gid)}/deploy`, {
    method: 'PATCH',
    jsonBody: { version },
    responseType: 'none',
    signal,
  });
}
