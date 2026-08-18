// Cribl Lake dataset operations (Workflow 2).
import { apiRequest, LAKE_ID } from './client';
import {
  type CriblLakeDataset,
  type CriblLakeStorageLocation,
  type Counted,
} from './types';

const PAGE_SIZE = 200;

function lake(path = ''): string {
  return `/products/lake/lakes/${encodeURIComponent(LAKE_ID)}${path}`;
}

/** Fetch every existing Lake dataset (used for name-collision detection). */
export async function listLakeDatasets(signal?: AbortSignal): Promise<CriblLakeDataset[]> {
  const all: CriblLakeDataset[] = [];
  let offset = 0;
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<CriblLakeDataset>>(lake('/datasets'), {
      query: { offset, limit: PAGE_SIZE, excludeDeleted: true },
      signal,
    });
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

/** List the Lake's storage locations (shared setting for created datasets). */
export async function listStorageLocations(
  signal?: AbortSignal,
): Promise<CriblLakeStorageLocation[]> {
  const res = await apiRequest<Counted<CriblLakeStorageLocation>>(lake('/storage-locations'), {
    query: { offset: 0, limit: PAGE_SIZE },
    signal,
  });
  return res.items ?? [];
}

/** Create a single Lake dataset. */
export async function createLakeDataset(
  dataset: CriblLakeDataset,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(lake('/datasets'), { method: 'POST', body: dataset, signal });
}
