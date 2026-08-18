// Pure helpers for the Pack Copy workflow: conflict planning and deriving the current
// workspace's identity from CRIBL_API_URL. The Cribl API remains the source of truth;
// these only shape data the UI already fetched.
import { type PackInfo } from '../api/types';

/** One selected source Pack paired with its destination-conflict status. */
export interface CopyPlanItem {
  pack: PackInfo;
  /** A Pack with the same id already exists in the destination worker group. */
  conflict: boolean;
  /** The destination's installed version, when conflicting. */
  existingVersion?: string;
}

/**
 * Build the copy plan: for each selected source Pack, flag whether a Pack with the
 * same id is already installed in the destination group. Conflicts are copied only if
 * explicitly overridden — by default they are skipped (never overwrite).
 */
export function buildCopyPlan(selected: PackInfo[], destPacks: PackInfo[]): CopyPlanItem[] {
  const destById = new Map(destPacks.map((p) => [p.id, p]));
  return selected.map((pack) => {
    const existing = destById.get(pack.id);
    return existing
      ? { pack, conflict: true, existingVersion: existing.version }
      : { pack, conflict: false };
  });
}

/** A human label for a Pack (display name falls back to id). */
export function packLabel(p: PackInfo): string {
  return p.displayName && p.displayName !== p.id ? `${p.displayName} (${p.id})` : p.id;
}

/**
 * Parse the hostname out of CRIBL_API_URL (e.g. "main-abc123.cribl.cloud"), used to
 * exclude the current workspace from the destination list. Returns '' if unavailable.
 */
export function currentWorkspaceHost(apiUrl: string | undefined): string {
  if (!apiUrl) return '';
  try {
    return new URL(apiUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Best-effort organization id derived from the current API host. Cribl.Cloud hosts
 * follow "<workspace>-<orgId>.cribl.cloud", so the org id is the segment after the
 * last hyphen of the first label. This is only a default the user can correct in the
 * setup form. Returns '' when it cannot be derived.
 */
export function deriveOrgId(apiUrl: string | undefined): string {
  const host = currentWorkspaceHost(apiUrl);
  if (!host || !host.endsWith('.cribl.cloud')) return '';
  const firstLabel = host.split('.')[0];
  const dash = firstLabel.lastIndexOf('-');
  return dash > 0 ? firstLabel.slice(dash + 1) : '';
}
