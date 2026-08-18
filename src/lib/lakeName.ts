// Client-side validation for Lake dataset creation.
//
// NOTE: the OpenAPI spec does not publish a naming pattern for CriblLakeDataset.id,
// so these rules are a conservative pre-check to catch obvious mistakes before the
// write. The Cribl API remains the source of truth and any server-side rejection is
// surfaced per-row in the results summary.

export const LAKE_NAME_RULE_TEXT =
  'Names must start with a lowercase letter and contain only lowercase letters, numbers, and underscores (max 100 characters).';

const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_LENGTH = 100;

/** Returns a human-readable reason when the name is invalid, otherwise null. */
export function validateLakeName(name: string): string | null {
  if (!name) return 'Name is required.';
  if (name.length > MAX_LENGTH) return `Name exceeds ${MAX_LENGTH} characters.`;
  if (!NAME_PATTERN.test(name)) return LAKE_NAME_RULE_TEXT;
  return null;
}

export interface LakeRow {
  /** Stable id for React keys and inline editing (not sent to the API). */
  key: string;
  name: string;
  description: string;
}

export interface RowIssues {
  /** Naming-rule violation. */
  nameError?: string;
  /** Name appears more than once in the current input. */
  duplicate?: boolean;
  /** Name already exists in the Lake. */
  collision?: boolean;
  /**
   * A Destination with this id already exists in the selected worker group. Only set
   * when the paired "create Lake Destinations" option is on and existing destination
   * names are supplied to validateRows.
   */
  destinationCollision?: boolean;
}

export function isRowValid(issues: RowIssues): boolean {
  return (
    !issues.nameError && !issues.duplicate && !issues.collision && !issues.destinationCollision
  );
}

/** Parse pasted text ("name" or "name, description" per line) into rows. */
export function parseRows(text: string, keyPrefix: string): LakeRow[] {
  const rows: LakeRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(',');
    const name = (comma === -1 ? line : line.slice(0, comma)).trim();
    const description = comma === -1 ? '' : line.slice(comma + 1).trim();
    rows.push({ key: `${keyPrefix}-${i}`, name, description });
  }
  return rows;
}

/**
 * Compute validation issues for every row, considering duplicates and existing names.
 *
 * When the paired-destination option is on, pass `existingDestNames` (the ids of
 * Destinations already in the target worker group) to also flag destination-id
 * collisions. Destination ids equal the dataset name, and the spec publishes no
 * separate id pattern for Outputs, so the Lake dataset naming rule (a strict subset)
 * already covers destination-id validity — no additional naming check is needed.
 */
export function validateRows(
  rows: LakeRow[],
  existingNames: ReadonlySet<string>,
  existingDestNames?: ReadonlySet<string>,
): RowIssues[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (r.name) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  }
  return rows.map((r) => {
    const issues: RowIssues = {};
    const nameError = validateLakeName(r.name);
    if (nameError) issues.nameError = nameError;
    if (r.name && (counts.get(r.name) ?? 0) > 1) issues.duplicate = true;
    if (r.name && existingNames.has(r.name)) issues.collision = true;
    if (r.name && existingDestNames?.has(r.name)) issues.destinationCollision = true;
    return issues;
  });
}
