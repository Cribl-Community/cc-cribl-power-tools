// Worker-group and Cribl Lake Destination operations (the paired-create option of
// Workflow 2). A Lake Destination is the `cribl_lake` variant of a Stream Output,
// created in the context of a worker group (/m/:gid/system/outputs).
import { apiRequest } from './client';
import {
  type Counted,
  type CriblLakeDestination,
  type GitCommitSummary,
  type OutputSummary,
  type WorkerGroup,
} from './types';

const PAGE_SIZE = 200;

/** Build a worker-group-context path (/m/:gid/...). */
function group(gid: string, path = ''): string {
  return `/m/${encodeURIComponent(gid)}${path}`;
}

/**
 * List the workspace's Stream worker groups (GET /master/groups?product=stream).
 * These are the groups a Lake Destination can be created in.
 */
export async function listWorkerGroups(signal?: AbortSignal): Promise<WorkerGroup[]> {
  const all: WorkerGroup[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<WorkerGroup>>('/master/groups', {
      query: { product: 'stream', offset, limit: PAGE_SIZE },
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
 * List every Destination (Output) in a worker group, paginating until exhausted.
 * Used to detect destination-id collisions before creating new ones.
 */
export async function listGroupOutputs(
  gid: string,
  signal?: AbortSignal,
): Promise<OutputSummary[]> {
  const all: OutputSummary[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<OutputSummary>>(group(gid, '/system/outputs'), {
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

/** Create a single Cribl Lake Destination in a worker group. */
export async function createLakeDestination(
  gid: string,
  destination: CriblLakeDestination,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, '/system/outputs'), {
    method: 'POST',
    body: destination,
    signal,
  });
}

/**
 * Commit a worker group's pending configuration changes (POST /m/:gid/version/commit)
 * and return the new commit hash, or undefined when there was nothing to commit.
 */
export async function commitGroup(
  gid: string,
  message: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const res = await apiRequest<Counted<GitCommitSummary>>(group(gid, '/version/commit'), {
    method: 'POST',
    body: { message },
    signal,
  });
  return res?.items?.[0]?.commit;
}

/** Deploy a committed configuration version to a worker group (PATCH .../deploy). */
export async function deployGroup(
  gid: string,
  version: string,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(`/master/groups/${encodeURIComponent(gid)}/deploy`, {
    method: 'PATCH',
    body: { version },
    signal,
  });
}
