import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Pill,
  Spinner,
  Text,
  TextField,
} from '@capra/core';
import { CircleCheckFilled, CircleXFilled } from '@capra/icons';
import { createLakeDataset, listLakeDatasets, listStorageLocations } from '../api/lake';
import {
  commitGroup,
  createLakeDestination,
  deployGroup,
  listGroupOutputs,
  listWorkerGroups,
} from '../api/destinations';
import { isConnected } from '../api/client';
import {
  LAKE_DATASET_FORMATS,
  type CriblLakeDataset,
  type CriblLakeDestination,
  type CriblLakeStorageLocation,
  type LakeDatasetFormat,
  type WorkerGroup,
} from '../api/types';
import {
  isRowValid,
  LAKE_NAME_RULE_TEXT,
  parseRows,
  validateRows,
  type LakeRow,
  type RowIssues,
} from '../lib/lakeName';
import { runBatch, type BatchItemResult } from '../lib/batch';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { ProgressBar } from '../components/ProgressBar';
import { ResultsSummary, type ResultRow } from '../components/ResultsSummary';

type View = 'form' | 'preview' | 'running' | 'results';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** Outcome of one object (dataset or destination) within a paired create. */
type SubStatus = 'ok' | 'failed' | 'skipped' | 'dryrun';
interface SubResult {
  status: SubStatus;
  error?: string;
}
interface PairedResult {
  name: string;
  dataset: SubResult;
  destination: SubResult;
}
/** What to do with the worker group after its destinations are created. */
type DeployMode = 'commit' | 'commit-deploy';

/** Result of the post-batch commit (and optional deploy) of the worker group. */
interface DeployStatus {
  attempted: boolean;
  /** Whether a deploy was requested (i.e. mode was 'commit-deploy'). */
  deployRequested: boolean;
  committed: boolean;
  deployed: boolean;
  error?: string;
  /** Set when there were no pending changes to commit. */
  note?: string;
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function LakeBulkCreate() {
  const connected = isConnected();

  const [existingNames, setExistingNames] = useState<ReadonlySet<string>>(new Set());
  const [storageLocations, setStorageLocations] = useState<CriblLakeStorageLocation[]>([]);
  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [loadError, setLoadError] = useState('');

  // Shared settings.
  const [storageLocationId, setStorageLocationId] = useState('');
  const [retentionDays, setRetentionDays] = useState('30');
  const [format, setFormat] = useState<LakeDatasetFormat | ''>('');

  // Paired Lake Destination creation (optional).
  const [createDestinations, setCreateDestinations] = useState(false);
  const [workerGroups, setWorkerGroups] = useState<WorkerGroup[]>([]);
  const [groupsState, setGroupsState] = useState<LoadState>('idle');
  const [groupsError, setGroupsError] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [deployMode, setDeployMode] = useState<DeployMode>('commit-deploy');
  const [existingDestNames, setExistingDestNames] = useState<ReadonlySet<string>>(new Set());
  const [destState, setDestState] = useState<LoadState>('idle');
  const [destError, setDestError] = useState('');

  // Names input.
  const [rawText, setRawText] = useState('');
  const [rows, setRows] = useState<LakeRow[]>([]);

  const [dryRun, setDryRun] = useState(false);
  const [view, setView] = useState<View>('form');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);
  // Results for a paired (dataset + destination) run.
  const [pairedResults, setPairedResults] = useState<PairedResult[]>([]);
  const [resultsPaired, setResultsPaired] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  useEffect(() => {
    if (!connected) {
      setLoadState('error');
      setLoadError('This app must run inside Cribl to reach the Lake API.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoadState('loading');
    Promise.all([listLakeDatasets(controller.signal), listStorageLocations(controller.signal)])
      .then(([datasets, locations]) => {
        if (cancelled) return;
        setExistingNames(new Set(datasets.map((d) => d.id)));
        setStorageLocations(locations);
        if (locations.length === 1 && locations[0].id) setStorageLocationId(locations[0].id);
        setLoadState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState('error');
        setLoadError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected]);

  // Fetch worker groups the first time the paired-destination option is enabled.
  // `groupsState` is read as a one-time guard, not a dependency: depending on it here
  // would abort the in-flight request the moment we set it to 'loading'.
  useEffect(() => {
    if (!createDestinations || !connected || groupsState !== 'idle') return;
    let cancelled = false;
    const controller = new AbortController();
    setGroupsState('loading');
    setGroupsError('');
    listWorkerGroups(controller.signal)
      .then((groups) => {
        if (cancelled) return;
        setWorkerGroups(groups);
        if (groups.length === 1) setSelectedGroupId(groups[0].id);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createDestinations, connected]);

  // Fetch the selected group's existing destinations for collision detection.
  useEffect(() => {
    if (!createDestinations || !connected || !selectedGroupId) {
      setDestState('idle');
      setExistingDestNames(new Set());
      setDestError('');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setDestState('loading');
    setDestError('');
    listGroupOutputs(selectedGroupId, controller.signal)
      .then((outputs) => {
        if (cancelled) return;
        setExistingDestNames(new Set(outputs.map((o) => o.id)));
        setDestState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setDestState('error');
        setDestError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [createDestinations, connected, selectedGroupId]);

  const issues = useMemo(
    () => validateRows(rows, existingNames, createDestinations ? existingDestNames : undefined),
    [rows, existingNames, createDestinations, existingDestNames],
  );
  const validCount = useMemo(() => issues.filter(isRowValid).length, [issues]);
  const invalidCount = rows.length - validCount;

  const retentionNum = Number(retentionDays);
  const retentionValid = Number.isInteger(retentionNum) && retentionNum > 0;
  const settingsValid = retentionValid; // storage location & format are optional per spec

  // With the toggle on, a worker group must be picked and its destinations loaded.
  const destinationsReady =
    !createDestinations ||
    (groupsState === 'ready' &&
      workerGroups.length > 0 &&
      selectedGroupId !== '' &&
      destState === 'ready');

  const canPreview =
    loadState === 'ready' &&
    rows.length > 0 &&
    validCount > 0 &&
    settingsValid &&
    destinationsReady;

  const selectedGroup = workerGroups.find((g) => g.id === selectedGroupId);
  const groupLabel = selectedGroup ? selectedGroup.name || selectedGroup.id : selectedGroupId;
  const commitDeployVerb = deployMode === 'commit-deploy' ? 'committed and deployed' : 'committed';

  function reparse() {
    setRows(parseRows(rawText, 'row'));
  }

  function updateRow(key: string, patch: Partial<LakeRow>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
  }

  const validRows = useMemo(
    () => rows.filter((_, i) => isRowValid(issues[i])),
    [rows, issues],
  );

  function buildDataset(row: LakeRow): CriblLakeDataset {
    const ds: CriblLakeDataset = { id: row.name };
    if (row.description) ds.description = row.description;
    if (format) ds.format = format;
    if (retentionValid) ds.retentionPeriodInDays = retentionNum;
    if (storageLocationId) ds.storageLocationId = storageLocationId;
    return ds;
  }

  // A cribl_lake Destination whose id/destPath match the dataset name, pointing at
  // that same dataset (and its storage location). All other fields use spec defaults.
  function buildDestination(row: LakeRow): CriblLakeDestination {
    const dest: CriblLakeDestination = {
      id: row.name,
      type: 'cribl_lake',
      destPath: row.name,
    };
    if (storageLocationId) dest.storageLocationId = storageLocationId;
    return dest;
  }

  async function runCreate() {
    setConfirmOpen(false);
    setView('running');
    setResults([]);
    setPairedResults([]);
    setDeployStatus(null);
    if (createDestinations) {
      setResultsPaired(true);
      await runCreatePaired();
    } else {
      setResultsPaired(false);
      setProgress({ done: 0, total: validRows.length });
      const batch = await runBatch(
        validRows,
        async (row) => {
          await createLakeDataset(buildDataset(row));
        },
        (p) => setProgress({ done: p.done, total: p.total }),
        { dryRun },
      );
      setResults(batch.map(toResultRow));
    }
    setView('results');
  }

  // Paired create: dataset first, then its destination. A dataset failure skips the
  // destination; a destination failure is reported without aborting the batch.
  async function runCreatePaired() {
    const gid = selectedGroupId;
    const total = validRows.length;
    setProgress({ done: 0, total });
    const out: PairedResult[] = [];
    let destinationsCreated = 0;

    for (let i = 0; i < validRows.length; i++) {
      const row = validRows[i];
      if (dryRun) {
        out.push({
          name: row.name,
          dataset: { status: 'dryrun' },
          destination: { status: 'dryrun' },
        });
      } else {
        const pr: PairedResult = {
          name: row.name,
          dataset: { status: 'failed' },
          destination: { status: 'skipped' },
        };
        let datasetOk = false;
        try {
          await createLakeDataset(buildDataset(row));
          pr.dataset = { status: 'ok' };
          datasetOk = true;
        } catch (err) {
          pr.dataset = { status: 'failed', error: toMessage(err) };
        }
        if (datasetOk) {
          try {
            await createLakeDestination(gid, buildDestination(row));
            pr.destination = { status: 'ok' };
            destinationsCreated++;
          } catch (err) {
            pr.destination = { status: 'failed', error: toMessage(err) };
          }
        }
        out.push(pr);
      }
      setProgress({ done: i + 1, total });
    }
    setPairedResults(out);

    // Committing (and optionally deploying) the worker group persists/activates the
    // new destinations. Only needed when a destination was actually created (not dry
    // run). The deploy step is skipped when the user chose "commit only".
    const wantDeploy = deployMode === 'commit-deploy';
    let deploy: DeployStatus = {
      attempted: false,
      deployRequested: wantDeploy,
      committed: false,
      deployed: false,
    };
    if (!dryRun && destinationsCreated > 0) {
      deploy = { ...deploy, attempted: true };
      try {
        const hash = await commitGroup(
          gid,
          `CC Cribl Power Tools: created ${destinationsCreated} Lake destination${
            destinationsCreated === 1 ? '' : 's'
          }`,
        );
        if (hash) {
          deploy = { ...deploy, committed: true };
          if (wantDeploy) {
            await deployGroup(gid, hash);
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
  }

  function toResultRow(r: BatchItemResult<LakeRow>): ResultRow {
    return { label: r.item.name, ok: r.ok, error: r.error, dryRun: r.dryRun };
  }

  function startOver() {
    setView('form');
    setResults([]);
    setPairedResults([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: 0 });
  }

  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <div className="wf-center">
        <Spinner title="Loading Lake configuration…" />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not load Lake configuration">
          {loadError}
        </Alert>
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          {dryRun
            ? 'Running dry run…'
            : createDestinations
              ? 'Creating datasets & destinations…'
              : 'Creating datasets…'}
        </Text>
        <ProgressBar
          done={progress.done}
          total={progress.total}
          label={
            dryRun
              ? 'Rows validated'
              : createDestinations
                ? 'Rows processed'
                : 'Datasets created'
          }
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
        {resultsPaired ? (
          <PairedResultsView rows={pairedResults} deploy={deployStatus} groupLabel={groupLabel} />
        ) : (
          <ResultsSummary noun="dataset" rows={results} />
        )}
        <div className="wf-actions">
          <Button variant="primary" onClick={startOver}>
            Create more
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
            Preview — {validRows.length} dataset{validRows.length === 1 ? '' : 's'}
            {createDestinations
              ? ` + ${validRows.length} destination${validRows.length === 1 ? '' : 's'}`
              : ''}
          </Text>
          <div className="wf-actions">
            <Button onClick={() => setView('form')}>Back</Button>
            <Button
              variant="primary"
              appearance={dryRun ? 'default' : 'danger'}
              onClick={() => (dryRun ? void runCreate() : setConfirmOpen(true))}
            >
              {dryRun ? 'Run dry run (no writes)' : `Create ${validRows.length}`}
            </Button>
          </div>
        </div>

        <Alert
          appearance={dryRun ? 'info' : 'warning'}
          title={dryRun ? 'Dry run' : 'Review before creating'}
        >
          {dryRun
            ? 'No datasets or destinations will be created. This shows exactly what would be sent.'
            : `Creating with shared settings: retention ${retentionNum} day(s)${
                format ? `, format ${format}` : ''
              }${storageLocationId ? `, storage ${storageLocationId}` : ''}.${
                createDestinations
                  ? ` Each dataset also gets a cribl_lake Destination in worker group “${groupLabel}”, then the group is ${commitDeployVerb}.`
                  : ''
              }`}
        </Alert>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Description</th>
                <th>Format</th>
                <th>Retention (days)</th>
                <th>Storage location</th>
                {createDestinations && (
                  <>
                    <th>Destination</th>
                    <th>Worker group</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {validRows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <Text variant="code">{r.name}</Text>
                  </td>
                  <td>{r.description || <span className="muted">—</span>}</td>
                  <td>{format || <span className="muted">default</span>}</td>
                  <td>{retentionNum}</td>
                  <td>{storageLocationId || <span className="muted">default</span>}</td>
                  {createDestinations && (
                    <>
                      <td>
                        <Text variant="code">{r.name}</Text>
                      </td>
                      <td>{groupLabel}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Modal
          isOpen={confirmOpen}
          title={`Create ${validRows.length} Lake dataset${validRows.length === 1 ? '' : 's'}${
            createDestinations ? ' + destinations' : ''
          }?`}
          confirmButtonText={`Create ${validRows.length}`}
          cancelButtonText="Cancel"
          onConfirm={() => void runCreate()}
          onClose={() => setConfirmOpen(false)}
        >
          <Text>
            This will create {validRows.length} new Lake dataset
            {validRows.length === 1 ? '' : 's'} with retention {retentionNum} day
            {retentionNum === 1 ? '' : 's'}
            {format ? `, format ${format}` : ''}
            {storageLocationId ? `, storage location ${storageLocationId}` : ''}.
            {createDestinations
              ? ` Each dataset also gets a matching cribl_lake Destination in worker group “${groupLabel}”. The group's pending changes will then be ${commitDeployVerb}.`
              : ''}
          </Text>
        </Modal>
      </div>
    );
  }

  // --- form view ----
  return (
    <div className="wf-section">
      <div className="wf-toolbar">
        <div className="wf-toolbar-spacer" />
        <LabeledSwitch label="Dry run" checked={dryRun} onChange={setDryRun} />
      </div>

      <div className="lake-form">
        <Text as="h3" variant="heading-sm">
          Shared settings
        </Text>
        <Text variant="body-sm-normal" color="subtle">
          Applied to every dataset created in this batch.
        </Text>

        <div className="form-grid">
          <label className="field">
            <Text variant="body-sm-semibold">Storage location</Text>
            <select
              className="native-select"
              value={storageLocationId}
              onChange={(e) => setStorageLocationId(e.target.value)}
            >
              <option value="">Default</option>
              {storageLocations.map((loc) => (
                <option key={loc.id ?? ''} value={loc.id ?? ''}>
                  {loc.id}
                  {loc.description ? ` — ${loc.description}` : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <Text variant="body-sm-semibold">Retention period (days)</Text>
            <TextField
              type="number"
              aria-label="Retention period in days"
              value={retentionDays}
              onChange={setRetentionDays}
            />
            {!retentionValid && (
              <Text variant="body-sm-normal" color="attention">
                Enter a positive whole number of days.
              </Text>
            )}
          </label>

          <label className="field">
            <Text variant="body-sm-semibold">Data format</Text>
            <select
              className="native-select"
              value={format}
              onChange={(e) => setFormat(e.target.value as LakeDatasetFormat | '')}
            >
              <option value="">Default</option>
              {LAKE_DATASET_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="lake-form">
        <LabeledSwitch
          label="Also create Lake Destinations"
          hint="Create a matching cribl_lake Destination for each dataset in a worker group, then commit and deploy the group."
          checked={createDestinations}
          onChange={setCreateDestinations}
        />
        {createDestinations && (
          <div className="edit-body">
            {groupsState === 'loading' && (
              <div className="wf-actions">
                <Spinner title="Loading worker groups…" />
                <Text variant="body-sm-normal" color="subtle">
                  Loading worker groups…
                </Text>
              </div>
            )}
            {groupsState === 'error' && (
              <Alert appearance="danger" title="Could not load worker groups">
                {groupsError} Destinations cannot be created until this succeeds — turn the option
                off to create datasets only.
              </Alert>
            )}
            {groupsState === 'ready' && workerGroups.length === 0 && (
              <Alert appearance="danger" title="No worker groups available">
                No Stream worker groups were returned for this workspace, so there is nowhere to
                create destinations. Turn the option off to create datasets only.
              </Alert>
            )}
            {groupsState === 'ready' && workerGroups.length > 0 && (
              <div className="form-grid">
                <label className="field">
                  <Text variant="body-sm-semibold">Worker group</Text>
                  <select
                    className="native-select"
                    aria-label="Worker group"
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                  >
                    <option value="">Select a worker group…</option>
                    {workerGroups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name || g.id}
                        {g.description ? ` — ${g.description}` : ''}
                      </option>
                    ))}
                  </select>
                  {selectedGroupId && destState === 'loading' && (
                    <Text variant="body-sm-normal" color="subtle">
                      Checking existing destinations…
                    </Text>
                  )}
                  {selectedGroupId && destState === 'error' && (
                    <Text variant="body-sm-normal" color="attention">
                      Could not load existing destinations: {destError}
                    </Text>
                  )}
                </label>

                <label className="field">
                  <Text variant="body-sm-semibold">After creating destinations</Text>
                  <select
                    className="native-select"
                    aria-label="Commit and deploy behavior"
                    value={deployMode}
                    onChange={(e) => setDeployMode(e.target.value as DeployMode)}
                  >
                    <option value="commit-deploy">Commit and deploy the worker group</option>
                    <option value="commit">Commit only (deploy later)</option>
                  </select>
                  <Text variant="body-sm-normal" color="subtle">
                    {deployMode === 'commit-deploy'
                      ? 'Changes are committed and deployed so the destinations go live.'
                      : 'Changes are committed but not deployed — deploy the group yourself to activate them.'}
                  </Text>
                </label>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="lake-names">
        <Text as="h3" variant="heading-sm">
          Dataset names
        </Text>
        <Text variant="body-sm-normal" color="subtle">
          One dataset per line. Optional description after a comma: <code>name, description</code>.{' '}
          {LAKE_NAME_RULE_TEXT}
        </Text>
        <textarea
          className="names-textarea"
          aria-label="Dataset names"
          rows={8}
          placeholder={'web_logs\nauth_events, Authentication audit events\napi_traffic'}
          value={rawText}
          onChange={(e) => setRawText(e.target.value)}
          onBlur={reparse}
        />
        <div className="wf-actions">
          <Button onClick={reparse} disabled={!rawText.trim()}>
            {rawText.trim()
              ? `Parse (${rawText.split(/\r?\n/).filter((l) => l.trim()).length} lines)`
              : 'Parse'}
          </Button>
          {rows.length > 0 && (
            <>
              <Pill appearance="success" variant="muted">
                {`${validCount} valid`}
              </Pill>
              <Pill appearance={invalidCount > 0 ? 'danger' : 'info'} variant="muted">
                {`${invalidCount} invalid`}
              </Pill>
            </>
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th className="col-status" />
                <th>Name</th>
                <th>Description</th>
                <th>Issue</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const issue = issues[i];
                const valid = isRowValid(issue);
                return (
                  <tr key={r.key} className={valid ? undefined : 'row-invalid'}>
                    <td className="col-status">
                      {valid ? null : (
                        <span className="status-fail" aria-label="invalid">
                          <CircleXFilled />
                        </span>
                      )}
                    </td>
                    <td>
                      <input
                        className="native-input"
                        aria-label={`Name for row ${i + 1}`}
                        value={r.name}
                        onChange={(e) => updateRow(r.key, { name: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        className="native-input"
                        aria-label={`Description for row ${i + 1}`}
                        value={r.description}
                        onChange={(e) => updateRow(r.key, { description: e.target.value })}
                      />
                    </td>
                    <td>
                      <RowIssueText issue={issue} />
                    </td>
                    <td>
                      <Button size="sm" appearance="danger" onClick={() => removeRow(r.key)}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="wf-actions">
        <Button variant="primary" disabled={!canPreview} onClick={() => setView('preview')}>
          {`Preview ${validCount} dataset${validCount === 1 ? '' : 's'}`}
        </Button>
        {dryRun && (
          <Pill appearance="info" variant="muted">
            Dry run enabled
          </Pill>
        )}
        {createDestinations && !destinationsReady && (
          <Text variant="body-sm-normal" color="subtle">
            Select a worker group (and let its destinations load) to continue.
          </Text>
        )}
        {invalidCount > 0 && (
          <Text variant="body-sm-normal" color="subtle">
            {invalidCount} invalid row{invalidCount === 1 ? '' : 's'} will be skipped.
          </Text>
        )}
      </div>
    </div>
  );
}

function RowIssueText({ issue }: { issue: RowIssues }) {
  if (isRowValid(issue)) {
    return (
      <Text variant="body-sm-normal" color="success">
        OK
      </Text>
    );
  }
  const parts: string[] = [];
  if (issue.nameError) parts.push(issue.nameError);
  if (issue.duplicate) parts.push('Duplicate name in input.');
  if (issue.collision) parts.push('A dataset with this name already exists.');
  if (issue.destinationCollision)
    parts.push('A destination with this name already exists in the selected worker group.');
  return (
    <Text variant="body-sm-normal" color="attention">
      {parts.join(' ')}
    </Text>
  );
}

/** Per-row succeeded/failed report for a paired dataset + destination create. */
function PairedResultsView({
  rows,
  deploy,
  groupLabel,
}: {
  rows: PairedResult[];
  deploy: DeployStatus | null;
  groupLabel: string;
}) {
  const dsOk = rows.filter((r) => r.dataset.status === 'ok').length;
  const dsFail = rows.filter((r) => r.dataset.status === 'failed').length;
  const destOk = rows.filter((r) => r.destination.status === 'ok').length;
  const destFail = rows.filter((r) => r.destination.status === 'failed').length;
  const anyDryRun = rows.some(
    (r) => r.dataset.status === 'dryrun' || r.destination.status === 'dryrun',
  );

  return (
    <div className="results">
      <div className="results-counts">
        <Pill appearance="success" variant="muted">{`${dsOk} dataset${
          dsOk === 1 ? '' : 's'
        } succeeded`}</Pill>
        <Pill appearance={dsFail > 0 ? 'danger' : 'info'} variant="muted">{`${dsFail} dataset${
          dsFail === 1 ? '' : 's'
        } failed`}</Pill>
        <Pill appearance="success" variant="muted">{`${destOk} destination${
          destOk === 1 ? '' : 's'
        } succeeded`}</Pill>
        <Pill
          appearance={destFail > 0 ? 'danger' : 'info'}
          variant="muted"
        >{`${destFail} destination${destFail === 1 ? '' : 's'} failed`}</Pill>
        {anyDryRun && (
          <Pill appearance="info" variant="muted">
            Dry run — no changes were written
          </Pill>
        )}
      </div>

      <CommitDeployAlert deploy={deploy} groupLabel={groupLabel} />

      <Text as="h3" variant="heading-sm">
        Datasets
      </Text>
      <table className="data-table results-table">
        <thead>
          <tr>
            <th className="col-status">Status</th>
            <th>Dataset</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`ds-${r.name}-${i}`}>
              <td className="col-status">
                <SubStatusIcon status={r.dataset.status} />
              </td>
              <td>
                <Text variant="code">{r.name}</Text>
              </td>
              <td>
                <SubResultDetail result={r.dataset} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Text as="h3" variant="heading-sm">
        Destinations in worker group “{groupLabel}”
      </Text>
      <table className="data-table results-table">
        <thead>
          <tr>
            <th className="col-status">Status</th>
            <th>Destination</th>
            <th>Worker group</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`dest-${r.name}-${i}`}>
              <td className="col-status">
                <SubStatusIcon status={r.destination.status} />
              </td>
              <td>
                <Text variant="code">{r.name}</Text>
              </td>
              <td>{groupLabel}</td>
              <td>
                <SubResultDetail result={r.destination} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Alert describing the post-batch commit (and optional deploy) of the worker group. */
function CommitDeployAlert({
  deploy,
  groupLabel,
}: {
  deploy: DeployStatus | null;
  groupLabel: string;
}) {
  if (!deploy?.attempted) return null;

  if (deploy.error) {
    return (
      <Alert appearance="danger" title={deploy.committed ? 'Deploy failed' : 'Commit failed'}>
        {deploy.error} The destinations were created, but worker group “{groupLabel}” was{' '}
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
      <Alert appearance="info" title="Worker group committed and deployed">
        Committed and deployed the new destinations to worker group “{groupLabel}”.
      </Alert>
    );
  }
  return (
    <Alert appearance="info" title="Worker group committed">
      Committed the new destinations to worker group “{groupLabel}”. Deploy the group to activate
      them.
    </Alert>
  );
}

function SubStatusIcon({ status }: { status: SubStatus }) {
  if (status === 'failed') {
    return (
      <span className="status-fail" aria-label="failed">
        <CircleXFilled />
      </span>
    );
  }
  if (status === 'skipped') {
    return (
      <span className="muted" aria-label="skipped">
        —
      </span>
    );
  }
  return (
    <span className="status-ok" aria-label={status === 'dryrun' ? 'would be created' : 'succeeded'}>
      <CircleCheckFilled />
    </span>
  );
}

function SubResultDetail({ result }: { result: SubResult }) {
  if (result.status === 'failed') {
    return (
      <Text variant="body-sm-normal" color="attention">
        <span className="mono">{result.error ?? 'Unknown error'}</span>
      </Text>
    );
  }
  const text =
    result.status === 'dryrun'
      ? 'Would be created (dry run)'
      : result.status === 'skipped'
        ? 'Skipped — dataset failed'
        : 'Created';
  return (
    <Text variant="body-sm-normal" color="subtle">
      {text}
    </Text>
  );
}
