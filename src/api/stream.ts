// Stream config-resource operations in a worker-group context (/m/:gid/...):
// Pipelines, Sources (Inputs) and Destinations (Outputs). Used by the bulk
// pipeline-assignment workflow (list + PATCH) and the bulk config-import workflow
// (list for collision checks + POST to create). Worker-group listing and the
// commit/deploy calls are reused from ./destinations.
import { apiRequest } from './client';
import { type Counted, type Pipeline, type StreamInput, type StreamOutput } from './types';

const PAGE_SIZE = 200;

/** Build a worker-group-context path (/m/:gid/...). */
function group(gid: string, path = ''): string {
  return `/m/${encodeURIComponent(gid)}${path}`;
}

/** Paginate an offset/limit collection endpoint into a single array. */
async function listAll<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  // Guard against a runaway loop while still handling large groups.
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<T>>(path, {
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

/** List every Pipeline in a worker group (GET /m/:gid/pipelines). */
export function listGroupPipelines(gid: string, signal?: AbortSignal): Promise<Pipeline[]> {
  return listAll<Pipeline>(group(gid, '/pipelines'), signal);
}

/** List every Source (Input) in a worker group (GET /m/:gid/system/inputs). */
export function listGroupSources(gid: string, signal?: AbortSignal): Promise<StreamInput[]> {
  return listAll<StreamInput>(group(gid, '/system/inputs'), signal);
}

/** List every Destination (Output) in a worker group (GET /m/:gid/system/outputs). */
export function listGroupDestinations(gid: string, signal?: AbortSignal): Promise<StreamOutput[]> {
  return listAll<StreamOutput>(group(gid, '/system/outputs'), signal);
}

/**
 * Build a lossless update body: the full Source/Destination object with only the
 * pipeline assignment changed. When `pipeline` is empty the field is removed, which
 * clears the assignment (the PATCH replaces the whole Source/Destination object).
 */
export function withPipeline<T extends { pipeline?: string }>(
  original: T,
  pipeline: string | undefined,
): T {
  const body = { ...original };
  if (pipeline) body.pipeline = pipeline;
  else delete body.pipeline;
  return body;
}

/** PATCH a Source's pre-processing Pipeline assignment (full-object update). */
export async function updateSourcePipeline(
  gid: string,
  input: StreamInput,
  pipeline: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, `/system/inputs/${encodeURIComponent(input.id)}`), {
    method: 'PATCH',
    body: withPipeline(input, pipeline),
    signal,
  });
}

/** PATCH a Destination's post-processing Pipeline assignment (full-object update). */
export async function updateDestinationPipeline(
  gid: string,
  output: StreamOutput,
  pipeline: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, `/system/outputs/${encodeURIComponent(output.id)}`), {
    method: 'PATCH',
    body: withPipeline(output, pipeline),
    signal,
  });
}

/** Create a Pipeline in a worker group (POST /m/:gid/pipelines). */
export async function createPipeline(
  gid: string,
  pipeline: Pipeline,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, '/pipelines'), { method: 'POST', body: pipeline, signal });
}

/** Create a Source (Input) in a worker group (POST /m/:gid/system/inputs). */
export async function createSource(
  gid: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, '/system/inputs'), { method: 'POST', body: input, signal });
}

/** Create a Destination (Output) in a worker group (POST /m/:gid/system/outputs). */
export async function createDestination(
  gid: string,
  output: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<void> {
  await apiRequest(group(gid, '/system/outputs'), { method: 'POST', body: output, signal });
}
