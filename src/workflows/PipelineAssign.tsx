import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Pill, Spinner, Text, TextField } from '@capra/core';
import { isConnected } from '../api/client';
import { commitGroup, deployGroup, listWorkerGroups } from '../api/destinations';
import {
  listGroupDestinations,
  listGroupPipelines,
  listGroupSources,
  updateDestinationPipeline,
  updateSourcePipeline,
} from '../api/stream';
import type { Pipeline, StreamInput, StreamOutput, WorkerGroup } from '../api/types';
import { runBatch, type BatchItemResult } from '../lib/batch';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { ProgressBar } from '../components/ProgressBar';
import { ResultsSummary, type ResultRow } from '../components/ResultsSummary';

type EntityKind = 'sources' | 'destinations';
type View = 'table' | 'preview' | 'running' | 'results';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type DeployMode = 'commit-deploy' | 'commit';

/** Sentinel value for the "clear the assignment" option in the pipeline picker. */
const CLEAR = '__clear__';

/** A Source or Destination, viewed through the fields this workflow touches. */
type Entity = StreamInput | StreamOutput;

interface DeployStatus {
  attempted: boolean;
  deployRequested: boolean;
  committed: boolean;
  deployed: boolean;
  error?: string;
  note?: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Copy that differs between the Sources and Destinations views. */
function kindCopy(kind: EntityKind) {
  return kind === 'sources'
    ? { noun: 'source', Noun: 'Source', phrase: 'pre-processing pipeline' }
    : { noun: 'destination', Noun: 'Destination', phrase: 'post-processing pipeline' };
}

export function PipelineAssign() {
  const connected = isConnected();

  // --- worker groups ---
  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  const [groupsState, setGroupsState] = useState<LoadState>('idle');
  const [groupsError, setGroupsError] = useState('');
  const [groupId, setGroupId] = useState('');

  // --- which entity kind is in view ---
  const [kind, setKind] = useState<EntityKind>('sources');

  // --- entities (sources or destinations) for the selected group ---
  const [items, setItems] = useState<Entity[]>([]);
  const [itemsState, setItemsState] = useState<LoadState>('idle');
  const [itemsError, setItemsError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // --- pipelines available in the selected group (the picker options) ---
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelinesState, setPipelinesState] = useState<LoadState>('idle');
  const [pipelinesError, setPipelinesError] = useState('');

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [targetPipeline, setTargetPipeline] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [deployMode, setDeployMode] = useState<DeployMode>('commit-deploy');

  const [view, setView] = useState<View>('table');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  const copy = kindCopy(kind);

  // Load worker groups once, on mount.
  useEffect(() => {
    if (!connected) {
      setGroupsState('error');
      setGroupsError('This app must run inside Cribl to reach the API.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setGroupsState('loading');
    setGroupsError('');
    listWorkerGroups(controller.signal)
      .then((g) => {
        if (cancelled) return;
        setGroups(g);
        setGroupsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setGroupsState('error');
        setGroupsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected]);

  // Pipelines for the selected group (picker options); reloaded when the group changes.
  useEffect(() => {
    if (!connected || !groupId) {
      setPipelines([]);
      setPipelinesState('idle');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setPipelinesState('loading');
    setPipelinesError('');
    listGroupPipelines(groupId, controller.signal)
      .then((p) => {
        if (cancelled) return;
        setPipelines(p);
        setPipelinesState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setPipelinesState('error');
        setPipelinesError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected, groupId]);

  // Entities for the selected group + kind; reloaded on group/kind change and after applying.
  useEffect(() => {
    if (!connected || !groupId) {
      setItems([]);
      setItemsState('idle');
      setSelection(new Set());
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setItemsState('loading');
    setItemsError('');
    setSelection(new Set());
    const load = kind === 'sources' ? listGroupSources : listGroupDestinations;
    load(groupId, controller.signal)
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setItemsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setItemsState('error');
        setItemsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected, groupId, kind, reloadToken]);

  const groupLabel = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return g ? g.name || g.id : groupId;
  }, [groups, groupId]);

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.id.toLowerCase().includes(q) || String(it.type ?? '').toLowerCase().includes(q),
    );
  }, [items, filterText]);

  const selectedItems = useMemo(
    () => items.filter((it) => selection.has(it.id)),
    [items, selection],
  );

  const allFilteredSelected = filtered.length > 0 && filtered.every((it) => selection.has(it.id));
  const someFilteredSelected = filtered.some((it) => selection.has(it.id));

  function toggleOne(id: string) {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAllFiltered() {
    setSelection((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) filtered.forEach((it) => next.delete(it.id));
      else filtered.forEach((it) => next.add(it.id));
      return next;
    });
  }
  function clearSelection() {
    setSelection(new Set());
  }

  const clearing = targetPipeline === CLEAR;
  const newPipeline = clearing ? undefined : targetPipeline;
  const pipelineLabel = clearing ? 'no pipeline' : targetPipeline;

  const canPreview =
    itemsState === 'ready' && selectedItems.length > 0 && targetPipeline !== '';

  // Verb for the confirmation/summary copy.
  const actionSummary = clearing
    ? `Clear the ${copy.phrase} for ${selectedItems.length} ${copy.noun}${
        selectedItems.length === 1 ? '' : 's'
      }`
    : `Assign pipeline “${targetPipeline}” as the ${copy.phrase} for ${selectedItems.length} ${
        copy.noun
      }${selectedItems.length === 1 ? '' : 's'}`;

  async function applyToItem(item: Entity): Promise<void> {
    if (kind === 'sources') {
      await updateSourcePipeline(groupId, item as StreamInput, newPipeline);
    } else {
      await updateDestinationPipeline(groupId, item as StreamOutput, newPipeline);
    }
  }

  function toResultRow(r: BatchItemResult<Entity>): ResultRow {
    return { label: r.item.id, ok: r.ok, error: r.error, dryRun: r.dryRun };
  }

  async function runApply() {
    setConfirmOpen(false);
    setView('running');
    setResults([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: selectedItems.length });

    const batch = await runBatch(
      selectedItems,
      applyToItem,
      (p) => setProgress({ done: p.done, total: p.total }),
      { dryRun },
    );
    setResults(batch.map(toResultRow));

    // Commit (and optionally deploy) once after the batch, so the assignments persist
    // and go live. Only when something actually changed.
    const changed = batch.filter((r) => r.ok && !r.dryRun).length;
    const wantDeploy = deployMode === 'commit-deploy';
    let deploy: DeployStatus = {
      attempted: false,
      deployRequested: wantDeploy,
      committed: false,
      deployed: false,
    };
    if (!dryRun && changed > 0) {
      deploy = { ...deploy, attempted: true };
      try {
        const hash = await commitGroup(
          groupId,
          `CC Cribl Power Tools: ${copy.phrase} assignment for ${changed} ${copy.noun}${
            changed === 1 ? '' : 's'
          }`,
        );
        if (hash) {
          deploy = { ...deploy, committed: true };
          if (wantDeploy) {
            await deployGroup(groupId, hash);
            deploy = { ...deploy, deployed: true };
          }
        } else {
          deploy = { ...deploy, committed: true, note: 'No pending changes to commit.' };
        }
      } catch (err) {
        deploy = { ...deploy, error: toMessage(err) };
      }
    }
    setDeployStatus(deploy);
    setView('results');
  }

  function startOver() {
    setView('table');
    setResults([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: 0 });
    setSelection(new Set());
    setTargetPipeline('');
    // Refresh the list so it reflects the new assignments.
    setReloadToken((n) => n + 1);
  }

  // ---------- render guards ----------
  if (groupsState === 'loading' || groupsState === 'idle') {
    return (
      <div className="wf-center">
        <Spinner title="Loading worker groups…" />
      </div>
    );
  }

  if (groupsState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not load worker groups">
          {groupsError}
        </Alert>
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          {dryRun ? 'Running dry run…' : 'Applying pipeline assignments…'}
        </Text>
        <ProgressBar
          done={progress.done}
          total={progress.total}
          label={dryRun ? `${copy.Noun}s validated` : `${copy.Noun}s updated`}
        />
      </div>
    );
  }

  if (view === 'results') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          Results
        </Text>
        <CommitDeployAlert deploy={deployStatus} groupLabel={groupLabel} />
        <ResultsSummary noun={copy.noun} rows={results} />
        <div className="wf-actions">
          <Button variant="primary" onClick={startOver}>
            {`Back to ${copy.noun}s`}
          </Button>
        </div>
      </div>
    );
  }

  if (view === 'preview') {
    return (
      <div className="wf-section">
        <div className="wf-actions wf-actions-between">
          <Text as="h2" variant="heading-md">
            Preview — {selectedItems.length} {copy.noun}
            {selectedItems.length === 1 ? '' : 's'}
          </Text>
          <div className="wf-actions">
            <Button onClick={() => setView('table')}>Back</Button>
            <Button
              variant="primary"
              appearance={dryRun ? 'default' : 'danger'}
              onClick={() => (dryRun ? void runApply() : setConfirmOpen(true))}
            >
              {dryRun ? 'Run dry run (no writes)' : `Apply to ${selectedItems.length}`}
            </Button>
          </div>
        </div>

        <Alert
          appearance={dryRun ? 'info' : 'warning'}
          title={dryRun ? 'Dry run' : 'Review before applying'}
        >
          {actionSummary} in worker group “{groupLabel}”.
          {dryRun
            ? ' No changes will be written.'
            : deployMode === 'commit-deploy'
              ? ' The group will then be committed and deployed.'
              : ' The group will then be committed (deploy it yourself to go live).'}
        </Alert>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>{copy.Noun} ID</th>
                <th>Type</th>
                <th>Current {copy.phrase}</th>
                <th aria-hidden />
                <th>New {copy.phrase}</th>
              </tr>
            </thead>
            <tbody>
              {selectedItems.map((it) => (
                <tr key={it.id}>
                  <td>
                    <Text variant="code">{it.id}</Text>
                  </td>
                  <td>
                    <Text variant="code">{it.type ?? '—'}</Text>
                  </td>
                  <td>
                    {it.pipeline ? (
                      <span className="diff-chip diff-chip-current">{it.pipeline}</span>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </td>
                  <td className="diff-arrow" aria-hidden>
                    →
                  </td>
                  <td>
                    {clearing ? (
                      <span className="muted">none</span>
                    ) : (
                      <span className="diff-chip diff-chip-new">{targetPipeline}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Modal
          isOpen={confirmOpen}
          title={`Apply to ${selectedItems.length} ${copy.noun}${
            selectedItems.length === 1 ? '' : 's'
          }?`}
          confirmButtonText={`Apply to ${selectedItems.length}`}
          cancelButtonText="Cancel"
          onConfirm={() => void runApply()}
          onClose={() => setConfirmOpen(false)}
        >
          <Text>
            {actionSummary} in worker group “{groupLabel}”, then{' '}
            {deployMode === 'commit-deploy' ? 'commit and deploy the group' : 'commit the group'}.
          </Text>
          <Text color="attention">
            This overwrites the {copy.phrase} on each selected {copy.noun}.
          </Text>
        </Modal>
      </div>
    );
  }

  // ---------- table view ----------
  return (
    <div className="wf-section">
      {/* Worker group + view toggle */}
      <div className="lake-form">
        <Text as="h3" variant="heading-sm">
          1. Worker group
        </Text>
        <div className="form-grid">
          <label className="field">
            <Text variant="body-sm-semibold">Worker group</Text>
            <select
              className="native-select"
              aria-label="Worker group"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            >
              <option value="">Select a worker group…</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name || g.id}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {groupId && (
        <>
          <div className="wf-toolbar">
            <div className="wf-actions" role="group" aria-label="Entity kind">
              <Button
                size="sm"
                variant={kind === 'sources' ? 'primary' : 'secondary'}
                onClick={() => setKind('sources')}
              >
                Sources
              </Button>
              <Button
                size="sm"
                variant={kind === 'destinations' ? 'primary' : 'secondary'}
                onClick={() => setKind('destinations')}
              >
                Destinations
              </Button>
            </div>
            <TextField
              aria-label={`Filter ${copy.noun}s`}
              placeholder="Filter by id or type"
              value={filterText}
              onChange={setFilterText}
            />
            <div className="wf-toolbar-spacer" />
            <LabeledSwitch label="Dry run" checked={dryRun} onChange={setDryRun} />
          </div>

          {itemsState === 'loading' && (
            <div className="wf-center">
              <Spinner title={`Loading ${copy.noun}s…`} />
            </div>
          )}
          {itemsState === 'error' && (
            <Alert appearance="danger" title={`Could not load ${copy.noun}s`}>
              {itemsError}
            </Alert>
          )}
          {itemsState === 'ready' && items.length === 0 && (
            <Alert appearance="info" title={`No ${copy.noun}s`}>
              This worker group has no {copy.noun}s.
            </Alert>
          )}

          {itemsState === 'ready' && items.length > 0 && (
            <>
              <div className="wf-selectbar">
                <Text variant="body-sm-normal" color="subtle">
                  {selection.size} selected · {filtered.length} shown · {items.length} total
                </Text>
                <div className="wf-selectbar-actions">
                  <Button size="sm" onClick={toggleAllFiltered} disabled={filtered.length === 0}>
                    {allFilteredSelected ? 'Deselect filtered' : 'Select filtered'}
                  </Button>
                  <Button size="sm" onClick={clearSelection} disabled={selection.size === 0}>
                    Clear
                  </Button>
                </div>
              </div>

              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="col-check">
                        <Checkbox
                          aria-label="Select all filtered"
                          checked={allFilteredSelected}
                          indeterminate={someFilteredSelected && !allFilteredSelected}
                          onChange={toggleAllFiltered}
                        />
                      </th>
                      <th>{copy.Noun} ID</th>
                      <th>Type</th>
                      <th>Current {copy.phrase}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((it) => (
                      <tr key={it.id} className={selection.has(it.id) ? 'row-selected' : undefined}>
                        <td className="col-check">
                          <Checkbox
                            aria-label={`Select ${it.id}`}
                            checked={selection.has(it.id)}
                            onChange={() => toggleOne(it.id)}
                          />
                        </td>
                        <td>
                          <Text variant="code">{it.id}</Text>
                        </td>
                        <td>
                          <Text variant="code">{it.type ?? '—'}</Text>
                        </td>
                        <td>
                          {it.pipeline ? (
                            <Text variant="code">{it.pipeline}</Text>
                          ) : (
                            <span className="muted">none</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {filtered.length === 0 && (
                  <div className="wf-empty">
                    <Text color="subtle">No {copy.noun}s match the current filter.</Text>
                  </div>
                )}
              </div>

              {/* Bulk edit panel */}
              <div className="edit-panel">
                <Text as="h3" variant="heading-sm">
                  Bulk edit {copy.phrase}
                </Text>
                <Text variant="body-sm-normal" color="subtle">
                  The chosen pipeline is assigned as the {copy.phrase} to all {selection.size}{' '}
                  selected {copy.noun}
                  {selection.size === 1 ? '' : 's'}.
                </Text>

                {pipelinesState === 'error' && (
                  <Alert appearance="warning" title="Could not load pipelines">
                    {pipelinesError} You can still clear assignments.
                  </Alert>
                )}

                <div className="form-grid">
                  <label className="field">
                    <Text variant="body-sm-semibold">Pipeline</Text>
                    <select
                      className="native-select"
                      aria-label="Pipeline to assign"
                      value={targetPipeline}
                      onChange={(e) => setTargetPipeline(e.target.value)}
                    >
                      <option value="">
                        {pipelinesState === 'loading' ? 'Loading pipelines…' : 'Select a pipeline…'}
                      </option>
                      <option value={CLEAR}>— Clear assignment (no pipeline) —</option>
                      {pipelines.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.id}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="field">
                    <Text variant="body-sm-semibold">After applying</Text>
                    <select
                      className="native-select"
                      aria-label="Commit and deploy behavior"
                      value={deployMode}
                      onChange={(e) => setDeployMode(e.target.value as DeployMode)}
                    >
                      <option value="commit-deploy">Commit and deploy the worker group</option>
                      <option value="commit">Commit only (deploy later)</option>
                    </select>
                  </label>
                </div>

                <div className="wf-actions">
                  <Button
                    variant="primary"
                    disabled={!canPreview}
                    onClick={() => setView('preview')}
                  >
                    Preview changes
                  </Button>
                  {targetPipeline !== '' && (
                    <Text variant="body-sm-normal" color="subtle">
                      {clearing
                        ? `Will clear the ${copy.phrase}`
                        : `Will assign “${pipelineLabel}”`}{' '}
                      on {selection.size} {copy.noun}
                      {selection.size === 1 ? '' : 's'}.
                    </Text>
                  )}
                  {dryRun && (
                    <Pill appearance="info" variant="muted">
                      Dry run enabled
                    </Pill>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Post-batch commit/deploy outcome banner. */
function CommitDeployAlert({
  deploy,
  groupLabel,
}: {
  deploy: DeployStatus | null;
  groupLabel: string;
}) {
  if (!deploy?.attempted) return null;
  const where = `worker group “${groupLabel}”`;
  if (deploy.error) {
    return (
      <Alert appearance="danger" title={deploy.committed ? 'Deploy failed' : 'Commit failed'}>
        {deploy.error} The assignments were written, but {where} was{' '}
        {deploy.committed ? 'committed and not deployed' : 'not committed'}; finish it manually.
      </Alert>
    );
  }
  if (deploy.note) {
    return (
      <Alert appearance="info" title="Nothing to commit">
        {deploy.note}
      </Alert>
    );
  }
  if (deploy.deployRequested && deploy.deployed) {
    return (
      <Alert appearance="info" title="Committed and deployed">
        Committed and deployed the changes to {where}.
      </Alert>
    );
  }
  return (
    <Alert appearance="info" title="Committed">
      Committed the changes to {where}. Deploy the group to activate them.
    </Alert>
  );
}
