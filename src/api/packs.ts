// Pack operations in the CURRENT workspace (the copy SOURCE, Workflow 3).
//
// These use the platform-authenticated current-workspace API (CRIBL_API_URL). Packs
// are per-worker-group, so calls are made in a group context (/m/:gid/packs). The
// copy DESTINATION lives in another workspace and is handled in managementPlane.ts.
import { apiRequest, apiRequestBinary } from './client';
import { type Counted, type PackInfo } from './types';

const PAGE_SIZE = 200;

/** Build a worker-group-context path (/m/:gid/...). */
function group(gid: string, path = ''): string {
  return `/m/${encodeURIComponent(gid)}${path}`;
}

/** List every Pack installed in a worker group (GET /m/:gid/packs), paginating. */
export async function listGroupPacks(gid: string, signal?: AbortSignal): Promise<PackInfo[]> {
  const all: PackInfo[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<PackInfo>>(group(gid, '/packs'), {
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
 * Export a Pack's full contents as a `.crbl` byte stream
 * (GET /m/:gid/packs/:id/export?mode=merge). `merge` force-merges local modifications
 * into the exported configuration (and drops encrypted fields), giving a complete,
 * portable Pack to install elsewhere.
 */
export async function exportPack(
  gid: string,
  packId: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  return apiRequestBinary(group(gid, `/packs/${encodeURIComponent(packId)}/export`), {
    query: { mode: 'merge', filename: `${packId}.crbl` },
    signal,
  });
}
