import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Pill, Spinner, Text, TextField } from '@capra/core';
import { isConnected } from '../api/client';
import { listWorkerGroups } from '../api/destinations';
import { listGroupPipelines } from '../api/stream';
import type { WorkerGroup } from '../api/types';
import { mapWithConcurrency } from '../lib/concurrency';
import {
  aggregateMatches,
  compileMatcher,
  sortMatches,
  summarize,
  type GroupPipelines,
  type SortKey,
} from '../lib/functionFinder';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { ProgressBar } from '../components/ProgressBar';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** How many worker groups to fetch pipelines from at once (mirrors other screens). */
const GROUP_CONCURRENCY = 5;

/** A worker group whose pipeline enumeration failed (shown as a per-group warning). */
interface GroupError {
  groupId: string;
  groupName: string;
  error: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort deep link to a pipeline in the Cribl Stream Leader UI. The route mirrors
 * the API's worker-group context (/m/:gid/pipelines/:id) and opens in the top frame
 * (this app runs sandboxed in an iframe — see AGENTS.md "Linking Out of Your App").
 * In `npm run dev` absolute paths resolve against the dev server, not the Leader, so
 * this only navigates correctly when the app is installed inside Cribl.
 */
function pipelineHref(groupId: string, pipelineId: string): string {
  return `/m/${encodeURIComponent(groupId)}/pipelines/${encodeURIComponent(pipelineId)}`;
}

export function FunctionFinder() {
  const connected = isConnected();

  // --- one-time enumeration of every group's pipelines ---
  const [enumState, setEnumState] = useState<LoadState>('idle');
  const [enumError, setEnumError] = useState('');
  const [groupsData, setGroupsData] = useState<GroupPipelines[]>([]);
  const [groupErrors, setGroupErrors] = useState<GroupError[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [reloadToken, setReloadToken] = useState(0);

  // --- search controls ---
  const [query, setQuery] = useState('');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('functionType');

  // Enumerate worker groups → pipelines once (and on manual refresh). Results are
  // cached in state so searching is instant client-side; one group failing to list
  // its pipelines is captured as a per-group warning and never blanks the whole set.
  useEffect(() => {
    if (!connected) {
      setEnumState('error');
      setEnumError('This app must run inside Cribl to reach the API.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setEnumState('loading');
    setEnumError('');
    setGroupsData([]);
    setGroupErrors([]);
    setProgress({ done: 0, total: 0 });

    (async () => {
      let groups: WorkerGroup[];
      try {
        groups = await listWorkerGroups(controller.signal);
      } catch (err) {
        if (!cancelled) {
          setEnumState('error');
          setEnumError(toMessage(err));
        }
        return;
      }
      if (cancelled) return;
      setProgress({ done: 0, total: groups.length });

      const data: GroupPipelines[] = [];
      const errors: GroupError[] = [];
      let done = 0;
      await mapWithConcurrency(groups, GROUP_CONCURRENCY, async (g) => {
        const groupName = g.name || g.id;
        try {
          const pipelines = await listGroupPipelines(g.id, controller.signal);
          data.push({ groupId: g.id, groupName, pipelines });
        } catch (err) {
          errors.push({ groupId: g.id, groupName, error: toMessage(err) });
        } finally {
          done += 1;
          if (!cancelled) setProgress({ done, total: groups.length });
        }
      });

      if (cancelled) return;
      setGroupsData(data);
      setGroupErrors(errors);
      setEnumState('ready');
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected, reloadToken]);

  // Compile the query once per change; a bad regex yields an error string, not a throw.
  const matcher = useMemo(
    () => compileMatcher(query.trim(), { regex, caseSensitive }),
    [query, regex, caseSensitive],
  );

  // Aggregate + sort matches across every group. Recomputed only when inputs change.
  const matches = useMemo(() => {
    if (!matcher.ok) return [];
    const found = aggregateMatches(groupsData, matcher.test, { enabledOnly });
    return sortMatches(found, sortKey);
  }, [matcher, groupsData, enabledOnly, sortKey]);

  const summary = useMemo(() => summarize(matches), [matches]);

  const totalGroups = groupsData.length;
  const searching = query.trim() !== '';

  // ---------- render guards ----------
  if (enumState === 'idle' || enumState === 'loading') {
    return (
      <div className="wf-section">
        <div className="wf-center">
          <Spinner title="Scanning worker groups for pipeline functions…" />
        </div>
        {progress.total > 0 && (
          <ProgressBar done={progress.done} total={progress.total} label="Worker groups scanned" />
        )}
      </div>
    );
  }

  if (enumState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not load worker groups">
          {enumError}
        </Alert>
      </div>
    );
  }

  // ---------- ready ----------
  return (
    <div className="wf-section">
      <div className="wf-toolbar">
        <TextField
          aria-label="Search functions"
          placeholder={regex ? 'Regex, e.g. ^ma(sk|th)$' : 'Search by function type or description'}
          value={query}
          onChange={setQuery}
        />
        <div className="wf-toolbar-spacer" />
        <LabeledSwitch label="Regex" checked={regex} onChange={setRegex} />
        <LabeledSwitch label="Case sensitive" checked={caseSensitive} onChange={setCaseSensitive} />
        <LabeledSwitch label="Enabled only" checked={enabledOnly} onChange={setEnabledOnly} />
      </div>

      <div className="wf-selectbar">
        <Text variant="body-sm-normal" color="subtle">
          Scanned {totalGroups} worker group{totalGroups === 1 ? '' : 's'}.
        </Text>
        <div className="wf-selectbar-actions">
          <label className="wf-sort">
            <Text variant="body-sm-semibold">Sort by</Text>
            <select
              className="native-select"
              aria-label="Sort results by"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="functionType">Function type</option>
              <option value="groupName">Worker group</option>
              <option value="pipelineId">Pipeline</option>
            </select>
          </label>
          <Button size="sm" onClick={() => setReloadToken((n) => n + 1)}>
            Refresh
          </Button>
        </div>
      </div>

      {/* Per-group warnings: partial enumeration failures don't blank the results. */}
      {groupErrors.length > 0 && (
        <Alert appearance="warning" title={`Could not scan ${groupErrors.length} worker group(s)`}>
          <ul className="wf-warning-list">
            {groupErrors.map((g) => (
              <li key={g.groupId}>
                <Text variant="code">{g.groupName}</Text>: {g.error}
              </li>
            ))}
          </ul>
          Results below exclude these groups.
        </Alert>
      )}

      {/* Invalid regex: surfaced inline, page stays usable. */}
      {!matcher.ok && (
        <Alert appearance="danger" title="Invalid search">
          {matcher.error}
        </Alert>
      )}

      {/* Empty state: nothing typed yet. */}
      {matcher.ok && !searching && (
        <div className="wf-empty">
          <Text color="subtle">
            Type a function type (e.g. <Text variant="code">samp</Text>) or description to search
            every pipeline function across all worker groups.
          </Text>
        </div>
      )}

      {/* Results. */}
      {matcher.ok && searching && (
        <>
          <Text variant="body-sm-normal" color="subtle">
            {summary.matchCount} match{summary.matchCount === 1 ? '' : 'es'} across{' '}
            {summary.pipelineCount} pipeline{summary.pipelineCount === 1 ? '' : 's'} in{' '}
            {summary.groupCount} worker group{summary.groupCount === 1 ? '' : 's'}.
          </Text>

          {matches.length === 0 ? (
            <div className="wf-empty">
              <Text color="subtle">
                No functions match “{query.trim()}”
                {enabledOnly ? ' among enabled functions' : ''}.
              </Text>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Function type</th>
                    <th>Description</th>
                    <th>Worker group</th>
                    <th>Pipeline</th>
                    <th>Position</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m, i) => (
                    <tr key={`${m.groupId}-${m.pipelineId}-${m.index}-${i}`}>
                      <td>
                        {m.enabled ? (
                          <Pill appearance="success" variant="muted">
                            Enabled
                          </Pill>
                        ) : (
                          <Pill appearance="info" variant="muted">
                            Disabled
                          </Pill>
                        )}
                      </td>
                      <td>
                        <Text variant="code">{m.functionType}</Text>
                      </td>
                      <td>
                        {m.description ? (
                          <Text variant="body-sm-normal">{m.description}</Text>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <Text variant="body-sm-normal">{m.groupName}</Text>
                      </td>
                      <td>
                        <a href={pipelineHref(m.groupId, m.pipelineId)} target="_top">
                          <Text variant="code">{m.pipelineId}</Text>
                        </a>
                      </td>
                      <td>
                        <Text variant="code">{m.index + 1}</Text>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
