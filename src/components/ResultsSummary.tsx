import { Text, Pill } from '@capra/core';
import { CircleCheckFilled, CircleXFilled } from '@capra/icons';

export interface ResultRow {
  label: string;
  ok: boolean;
  error?: string;
  dryRun?: boolean;
}

interface ResultsSummaryProps {
  /** Noun for the items, e.g. "dataset" (pluralized in the caption). */
  noun: string;
  rows: ResultRow[];
}

/** Succeeded/failed summary with a per-item table and captured error messages. */
export function ResultsSummary({ noun, rows }: ResultsSummaryProps) {
  const succeeded = rows.filter((r) => r.ok).length;
  const failed = rows.length - succeeded;
  const anyDryRun = rows.some((r) => r.dryRun);

  return (
    <div className="results">
      <div className="results-counts">
        <Pill appearance="success" variant="muted">
          {`${succeeded} succeeded`}
        </Pill>
        <Pill appearance={failed > 0 ? 'danger' : 'info'} variant="muted">
          {`${failed} failed`}
        </Pill>
        {anyDryRun && (
          <Pill appearance="info" variant="muted">
            Dry run — no changes were written
          </Pill>
        )}
      </div>

      <table className="data-table results-table">
        <thead>
          <tr>
            <th className="col-status">Status</th>
            <th>{noun.charAt(0).toUpperCase() + noun.slice(1)}</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.label}-${i}`}>
              <td className="col-status">
                {r.ok ? (
                  <span className="status-ok" aria-label="succeeded">
                    <CircleCheckFilled />
                  </span>
                ) : (
                  <span className="status-fail" aria-label="failed">
                    <CircleXFilled />
                  </span>
                )}
              </td>
              <td>
                <Text variant="code">{r.label}</Text>
              </td>
              <td>
                {r.ok ? (
                  <Text variant="body-sm-normal" color="subtle">
                    {r.dryRun ? 'Would be applied (dry run)' : 'Applied'}
                  </Text>
                ) : (
                  <Text variant="body-sm-normal" color="attention">
                    <span className="mono">{r.error ?? 'Unknown error'}</span>
                  </Text>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
