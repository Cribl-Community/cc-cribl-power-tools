// Types mirrored from the Cribl OpenAPI spec (openapi.json). Only the fields this
// app reads or writes are modeled explicitly; unknown fields are preserved via the
// index signature so PATCH round-trips do not drop existing dataset configuration.

/** A Cribl Search Dataset as returned by GET /search/datasets (DatasetEnriched). */
export interface SearchDataset {
  id: string;
  type: string;
  provider: string;
  description?: string;
  /**
   * Ordered event-breaker ruleset IDs applied when reading events from the Dataset.
   * This is the field the app treats as the dataset's "datatype rulesets".
   */
  breakerRulesets?: string[];
  // Preserve every other field so update round-trips are lossless.
  [key: string]: unknown;
}

/**
 * Enrichment / read-only fields added by the list endpoint (DatasetEnriched) that are
 * NOT part of the writable Dataset schema. These must be stripped before PATCH.
 */
export const DATASET_ENRICHMENT_FIELDS: readonly string[] = [
  'criblLakeCacheServerId',
  'engine',
  'engineDeleted',
  'favorites',
  'lastUsed',
  'maxEventTime',
  'minEventTime',
  'searchCount30d',
  'storageClasses',
  'totalByteCount',
  'totalEventCount',
];

/** A single access-control policy entry (ResourcePolicy) returned by the ACL endpoints. */
export interface ResourcePolicy {
  gid: string;
  policy: string;
  type: string;
  id?: string;
}

/** Per-subject ACL entry (UserAccessControlList) — `user` is a user id or a team id. */
export interface UserAccessControlList {
  user: string;
  perms: ResourcePolicy[];
}

/** AccessControl: subject id -> array of policy strings. */
export type AccessControl = Record<string, string[]>;

/** Body for POST .../acl/apply and .../acl/teams/apply (AccessControlSchema). */
export interface AccessControlSchema {
  add?: AccessControl;
  rm?: AccessControl;
}

/** Envelope shared by counted/paginated Cribl responses. */
export interface Counted<T> {
  items: T[];
  count: number;
  totalCount?: number;
  offset?: number;
  limit?: number;
}

/** An Event Breaker ruleset (EventBreakerRuleset) — a valid value for breakerRulesets. */
export interface EventBreakerRuleset {
  id: string;
  description?: string;
  [key: string]: unknown;
}

/** A platform user (User) — only the fields used for the share-permission picker. */
export interface User {
  id: string;
  username: string;
  first?: string;
  last?: string;
  email?: string;
  [key: string]: unknown;
}

/** A platform team (Team) — only the fields used for the share-permission picker. */
export interface Team {
  id: string;
  name: string;
  description?: string;
  [key: string]: unknown;
}

// --- Cribl Lake ---

export const LAKE_DATASET_FORMATS = ['ddss', 'json', 'netskope', 'parquet'] as const;
export type LakeDatasetFormat = (typeof LAKE_DATASET_FORMATS)[number];

/** A Cribl Lake Dataset (CriblLakeDataset). `id` is the only required field on create. */
export interface CriblLakeDataset {
  id: string;
  description?: string;
  format?: LakeDatasetFormat;
  retentionPeriodInDays?: number;
  storageLocationId?: string;
  bucketName?: string;
  [key: string]: unknown;
}

export const STORAGE_LOCATION_PROVIDERS = ['aws-s3', 'azure_blob', 'netskope'] as const;

/** A Cribl Lake Storage Location (CriblLakeStorageLocation). */
export interface CriblLakeStorageLocation {
  id?: string;
  description?: string;
  provider: string;
  status?: unknown;
  [key: string]: unknown;
}

// --- Worker groups & Lake destinations (paired Lake Destination creation) ---

/**
 * A Cribl config group (ConfigGroup) as returned by GET /master/groups. For this
 * app we only read the fields needed to render and target the worker-group picker.
 */
export interface WorkerGroup {
  id: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * A Cribl Lake Destination — the `cribl_lake` variant of Output (OutputCriblLake).
 * `id` and `type` are required on create; `destPath` names the target Lake dataset
 * and `storageLocationId` is the storage location that contains it (per the schema).
 * Other fields are left to spec defaults but preserved via the index signature.
 */
export interface CriblLakeDestination {
  id: string;
  type: 'cribl_lake';
  /** Lake dataset to send the data to (OutputCriblLake.destPath). */
  destPath: string;
  /** Storage location that contains the target Lake dataset. */
  storageLocationId?: string;
  [key: string]: unknown;
}

/** Minimal shape of an Output when listing a group's destinations (for id collisions). */
export interface OutputSummary {
  id: string;
  type?: string;
  [key: string]: unknown;
}

/** A single Git commit summary (GitCommitSummary) returned by POST .../version/commit. */
export interface GitCommitSummary {
  commit: string;
  [key: string]: unknown;
}

// --- Packs & cross-workspace copy (Workflow 3) ---

/**
 * An installed Pack as returned by GET /m/:gid/packs (PackInfo). We read `id`,
 * `displayName` and `version` to drive selection and conflict detection; the rest
 * is preserved via the index signature.
 */
export interface PackInfo {
  id: string;
  displayName?: string;
  version?: string;
  description?: string;
  author?: string;
  source?: string;
  [key: string]: unknown;
}

/**
 * Body for POST /m/:gid/packs (PackRequestBody) to install a Pack. `source` is the
 * staging id returned by the preceding PUT /m/:gid/packs upload; `id`/`version` name
 * the Pack being installed.
 */
export interface PackInstallBody {
  id: string;
  source: string;
  version?: string;
  displayName?: string;
  description?: string;
  author?: string;
  [key: string]: unknown;
}

/** Response of PUT /m/:gid/packs (UploadPackResponse) — a staging source id. */
export interface UploadPackResponse {
  source: string;
}

/**
 * A Cribl.Cloud Workspace (WorkspaceSchema) as returned by the management-plane
 * GET /v1/organizations/{orgId}/workspaces. `leaderFQDN` is the host of that
 * workspace's Leader API, which cross-workspace calls target.
 */
export interface WorkspaceInfo {
  workspaceId: string;
  region?: string;
  leaderFQDN: string;
  state?: 'Provisioning' | 'Active' | 'Inactive' | 'Failed' | 'Deprovisioning';
  alias?: string;
  description?: string;
  tags?: string[];
  [key: string]: unknown;
}

/** Envelope for the management-plane workspaces list (WorkspacesListResponseDTO). */
export interface WorkspacesListResponse {
  items: WorkspaceInfo[];
  count: number;
}
