// Validation + collision detection for the bulk config-import workflow. Pure
// functions (no I/O) so the import review can be computed and reasoned about
// independently of the network. One import operation handles a single config
// type (Pipelines, Sources, or Destinations).

export type ImportKind = 'pipelines' | 'sources' | 'destinations';

export interface KindMeta {
  kind: ImportKind;
  /** Singular, capitalized: "Pipeline" / "Source" / "Destination". */
  noun: string;
  /** Plural, lowercase: "pipelines" / "sources" / "destinations". */
  plural: string;
}

export const IMPORT_KINDS: KindMeta[] = [
  { kind: 'pipelines', noun: 'Pipeline', plural: 'pipelines' },
  { kind: 'sources', noun: 'Source', plural: 'sources' },
  { kind: 'destinations', noun: 'Destination', plural: 'destinations' },
];

export function kindMeta(kind: ImportKind): KindMeta {
  return IMPORT_KINDS.find((k) => k.kind === kind) ?? IMPORT_KINDS[0];
}

/**
 * Per-file outcome:
 * - `valid`     — parses, matches the selected type, and its id is free to create.
 * - `invalid`   — bad JSON, wrong shape, or wrong type for this import.
 * - `duplicate` — a valid config whose id repeats another file in the same batch.
 * - `collision` — a valid config whose id already exists in the target group.
 * Only `valid` files are imported; the rest are skipped (never overwritten).
 */
export type FileStatus = 'valid' | 'invalid' | 'duplicate' | 'collision';

export interface ImportFileResult {
  name: string;
  status: FileStatus;
  id?: string;
  config?: Record<string, unknown>;
  error?: string;
}

/** A file whose text has already been read, ready for validation. */
export interface UploadedFile {
  name: string;
  text: string;
}

/**
 * Parse a file's text into a single config object. Unwraps the two common Cribl
 * export shapes — a one-element array and a one-element `{ items: [...] }` envelope
 * — so files exported straight from the product validate cleanly.
 */
export function parseConfig(text: string): { config?: Record<string, unknown>; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      return { error: `Expected a single config object, but the file is an array of ${parsed.length}` };
    }
    parsed = parsed[0];
  } else if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { items?: unknown }).items)
  ) {
    const items = (parsed as { items: unknown[] }).items;
    if (items.length !== 1) {
      return { error: `Expected a single config object, but "items" holds ${items.length}` };
    }
    parsed = items[0];
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Expected a JSON object describing a single config' };
  }
  return { config: parsed as Record<string, unknown> };
}

/**
 * Check that a parsed config structurally matches the selected kind. Returns an
 * error message, or null when the shape is acceptable. Pipelines require a `conf`
 * object; Sources and Destinations require a `type` string. This reliably rejects
 * a Pipeline uploaded as a Source (and vice-versa); a Source uploaded as a
 * Destination has the same shape and is instead caught by the API at import time.
 */
export function validateShape(config: Record<string, unknown>, kind: ImportKind): string | null {
  const id = config.id;
  if (typeof id !== 'string' || !id.trim()) return "Missing required string field 'id'";

  if (kind === 'pipelines') {
    const conf = config.conf;
    if (typeof conf !== 'object' || conf === null || Array.isArray(conf)) {
      return "Not a Pipeline config: missing object field 'conf'";
    }
    return null;
  }

  const noun = kindMeta(kind).noun;
  const type = config.type;
  if (typeof type !== 'string' || !type.trim()) {
    return `Not a ${noun} config: missing string field 'type'`;
  }
  return null;
}

/**
 * Validate a batch of uploaded files against a target group's existing ids. The
 * result preserves file order and classifies each file; only `valid` entries carry
 * a config that should be created.
 */
export function buildImportPlan(
  files: UploadedFile[],
  kind: ImportKind,
  existingIds: ReadonlySet<string>,
): ImportFileResult[] {
  const noun = kindMeta(kind).noun;
  const seen = new Set<string>();

  return files.map((f) => {
    const { config, error } = parseConfig(f.text);
    if (error || !config) {
      return { name: f.name, status: 'invalid', error };
    }
    const shapeError = validateShape(config, kind);
    const id = typeof config.id === 'string' ? config.id : undefined;
    if (shapeError) {
      return { name: f.name, status: 'invalid', id, config, error: shapeError };
    }
    const key = id as string;
    if (seen.has(key)) {
      return {
        name: f.name,
        status: 'duplicate',
        id: key,
        config,
        error: `Duplicate id "${key}" — another file in this batch already uses it`,
      };
    }
    seen.add(key);
    if (existingIds.has(key)) {
      return {
        name: f.name,
        status: 'collision',
        id: key,
        config,
        error: `A ${noun} with id "${key}" already exists in the target group`,
      };
    }
    return { name: f.name, status: 'valid', id: key, config };
  });
}

/** Count each status across a plan, for the review summary. */
export function summarizePlan(plan: ImportFileResult[]): Record<FileStatus, number> {
  const counts: Record<FileStatus, number> = { valid: 0, invalid: 0, duplicate: 0, collision: 0 };
  for (const r of plan) counts[r.status] += 1;
  return counts;
}
