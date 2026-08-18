// Cribl Search dataset operations (Workflow 1).
import { apiRequest, SEARCH_PREFIX } from './client';
import {
  DATASET_ENRICHMENT_FIELDS,
  type AccessControlSchema,
  type Counted,
  type EventBreakerRuleset,
  type SearchDataset,
  type Team,
  type User,
  type UserAccessControlList,
} from './types';

const PAGE_SIZE = 200;

function ds(path = ''): string {
  return `${SEARCH_PREFIX}/search/datasets${path}`;
}

/** Paginate an offset/limit-based collection endpoint into a single array. */
async function listAll<T>(
  path: string,
  signal?: AbortSignal,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<T>>(path, {
      query: { ...query, offset, limit: PAGE_SIZE },
      signal,
    });
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

/** Fetch every Search dataset, paginating until the list is exhausted. */
export async function listSearchDatasets(signal?: AbortSignal): Promise<SearchDataset[]> {
  const all: SearchDataset[] = [];
  let offset = 0;
  // Guard against a runaway loop while still handling large workspaces.
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<SearchDataset>>(ds(), {
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
 * Build a lossless PATCH body: start from the full dataset, drop read-only enrichment
 * fields, and apply the new breakerRulesets. Every other field is preserved so the
 * update never clobbers unrelated configuration.
 */
export function buildDatasetUpdateBody(
  original: SearchDataset,
  breakerRulesets: string[],
): SearchDataset {
  const body: SearchDataset = { ...original, breakerRulesets };
  for (const field of DATASET_ENRICHMENT_FIELDS) delete body[field];
  return body;
}

/** PATCH a dataset (used to update breakerRulesets). */
export async function updateSearchDataset(
  body: SearchDataset,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(ds(`/${encodeURIComponent(body.id)}`), {
    method: 'PATCH',
    body,
    signal,
  });
}

/** GET current per-user ACL for a dataset. */
export async function getDatasetUserAcl(
  id: string,
  signal?: AbortSignal,
): Promise<UserAccessControlList[]> {
  const res = await apiRequest<Counted<UserAccessControlList>>(
    ds(`/${encodeURIComponent(id)}/acl`),
    { signal },
  );
  return res.items ?? [];
}

/** GET current per-team ACL for a dataset. */
export async function getDatasetTeamAcl(
  id: string,
  signal?: AbortSignal,
): Promise<UserAccessControlList[]> {
  const res = await apiRequest<Counted<UserAccessControlList>>(
    ds(`/${encodeURIComponent(id)}/acl/teams`),
    { signal },
  );
  return res.items ?? [];
}

/** Apply add/remove changes to a dataset's per-user ACL. */
export async function applyDatasetUserAcl(
  id: string,
  schema: AccessControlSchema,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(ds(`/${encodeURIComponent(id)}/acl/apply`), {
    method: 'POST',
    body: schema,
    signal,
  });
}

/** Apply add/remove changes to a dataset's per-team ACL. */
export async function applyDatasetTeamAcl(
  id: string,
  schema: AccessControlSchema,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(ds(`/${encodeURIComponent(id)}/acl/teams/apply`), {
    method: 'POST',
    body: schema,
    signal,
  });
}

/**
 * List Event Breaker rulesets available in the search context. These are the valid
 * values for a dataset's breakerRulesets field, used to populate the ruleset picker.
 */
export function listBreakerRulesets(signal?: AbortSignal): Promise<EventBreakerRuleset[]> {
  return listAll<EventBreakerRuleset>(`${SEARCH_PREFIX}/lib/breakers`, signal);
}

/**
 * List users for the share-permission subject picker.
 *
 * On Cribl.Cloud the `/system/users` collection is on-prem only, so we use the
 * product Members endpoint (`/products/search/users`), which returns the users
 * belonging to the Search product in a single CountedUser response. On-prem, that
 * product path may be absent, so we fall back to the paginated `/system/users`.
 */
export async function listUsers(signal?: AbortSignal): Promise<User[]> {
  try {
    const res = await apiRequest<Counted<User>>('/products/search/users', { signal });
    return res.items ?? [];
  } catch {
    return listAll<User>('/system/users', signal);
  }
}

/** List platform teams (for the share-permission subject picker). */
export function listTeams(signal?: AbortSignal): Promise<Team[]> {
  return listAll<Team>('/system/teams', signal);
}
