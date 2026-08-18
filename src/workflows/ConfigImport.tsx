import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Pill, Radio, RadioGroup, Spinner, Text } from '@capra/core';
import { isConnected } from '../api/client';
import { commitGroup, deployGroup, listWorkerGroups } from '../api/destinations';
import {
  createDestination,
  createPipeline,
  createSource,
  listGroupDestinations,
  listGroupPipelines,
  listGroupSources,
} from '../api/stream';
import type { Pipeline, WorkerGroup } from '../api/types';
import {
  buildImportPlan,
  IMPORT_KINDS,
  kindMeta,
  summarizePlan,
  type ImportFileResult,
  type ImportKind,
  type UploadedFile,
} from '../lib/bulkImport';
import { runBatch, type BatchItemResult } from '../lib/batch';
import { ProgressBar } from '../components/ProgressBar';
import { ResultsSummary, type ResultRow } from '../components/ResultsSummary';

type View = 'wizard' | 'validating' | 'review' | 'running' | 'results';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type DeployMode = 'commit-deploy' | 'commit';

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const STATUS_LABEL: Record<ImportFileResult['status'], string> = {
  valid: 'Import',
  invalid: 'Invalid',
  duplicate: 'Duplicate',
  collision: 'Exists',
};

export function ConfigImport() {
  const connected = isConnected();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [kind, setKind] = useState<ImportKind>('pipelines');

  const [groups, setGroups] = useState<WorkerGroup[]>([]);
  const [groupsState, setGroupsState] = useState<LoadState>('idle');
  const [groupsError, setGroupsError] = useState('');
  const [groupId, setGroupId] = useState('');

  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [skippedNote, setSkippedNote] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [deployMode, setDeployMode] = useState<DeployMode>('commit-deploy');

  const [view, setView] = useState<View>('wizard');
  const [validateError, setValidateError] = useState('');
  const [plan, setPlan] = useState<ImportFileResult[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  const meta = kindMeta(kind);

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

  const groupLabel = useMemo(() => {
    const g = groups.find((x) => x.id === groupId);
    return g ? g.name || g.id : groupId;
  }, [groups, groupId]);

  // --- file intake ---
  async function addFiles(list: FileList | File[]) {
    const all = Array.from(list);
    const json = all.filter(
      (f) => f.name.toLowerCase().endsWith('.json') || f.type === 'application/json',
    );
    const ignored = all.length - json.length;
    setSkippedNote(
      ignored > 0 ? `Ignored ${ignored} non-JSON file${ignored === 1 ? '' : 's'}.` : '',
    );
    const read = await Promise.all(
      json.map(async (f) => ({ name: f.name, text: await f.text() })),
    );
    setFiles((prev) => {
      const names = new Set(prev.map((p) => p.name));
      const fresh = read.filter((r) => !names.has(r.name));
      return [...prev, ...fresh];
    });
  }

  function removeFile(name: string) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  }

  // --- validation: fetch existing ids, then build the plan ---
  async function validate() {
    setView('validating');
    setValidateError('');
    try {
      const existing =
        kind === 'pipelines'
          ? await listGroupPipelines(groupId)
          : kind === 'sources'
            ? await listGroupSources(groupId)
            : await listGroupDestinations(groupId);
      const existingIds = new Set(existing.map((x) => x.id));
      setPlan(buildImportPlan(files, kind, existingIds));
      setView('review');
    } catch (err) {
      setValidateError(toMessage(err));
      setView('wizard');
    }
  }

  const validEntries = useMemo(() => plan.filter((r) => r.status === 'valid'), [plan]);
  const counts = useMemo(() => summarizePlan(plan), [plan]);

  function toResultRow(r: BatchItemResult<ImportFileResult>): ResultRow {
    return { label: r.item.id ?? r.item.name, ok: r.ok, error: r.error, dryRun: r.dryRun };
  }

  async function runImport() {
    setConfirmOpen(false);
    setView('running');
    setResults([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: validEntries.length });

    const create = (cfg: Record<string, unknown>): Promise<void> => {
      if (kind === 'pipelines') return createPipeline(groupId, cfg as unknown as Pipeline);
      if (kind === 'sources') return createSource(groupId, cfg);
      return createDestination(groupId, cfg);
    };

    const batch = await runBatch(
      validEntries,
      (entry) => create(entry.config as Record<string, unknown>),
      (p) => setProgress({ done: p.done, total: p.total }),
    );
    setResults(batch.map(toResultRow));

    // Commit (and optionally deploy) once after the batch, for the configs created.
    const created = batch.filter((r) => r.ok).length;
    const wantDeploy = deployMode === 'commit-deploy';
    let deploy: DeployStatus = {
      attempted: false,
      deployRequested: wantDeploy,
      committed: false,
      deployed: false,
    };
    if (created > 0) {
      deploy = { ...deploy, attempted: true };
      try {
        const hash = await commitGroup(
          groupId,
          `CC Cribl Power Tools: imported ${created} ${meta.plural}`,
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
    setStep(1);
    setFiles([]);
    setPlan([]);
    setResults([]);
    setDeployStatus(null);
    setSkippedNote('');
    setProgress({ done: 0, total: 0 });
    setView('wizard');
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

  if (view === 'validating') {
    return (
      <div className="wf-center">
        <Spinner title="Validating files…" />
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          Importing {meta.plural}…
        </Text>
        <ProgressBar done={progress.done} total={progress.total} label={`${meta.noun}s created`} />
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
        <ResultsSummary noun={meta.noun.toLowerCase()} rows={results} />
        <div className="wf-actions">
          <Button variant="primary" onClick={startOver}>
            Import more configs
          </Button>
        </div>
      </div>
    );
  }

  if (view === 'review') {
    return (
      <div className="wf-section">
        <div className="wf-actions wf-actions-between">
          <Text as="h2" variant="heading-md">
            Review — {validEntries.length} of {plan.length} file
            {plan.length === 1 ? '' : 's'} will be imported
          </Text>
          <div className="wf-actions">
            <Button onClick={() => setView('wizard')}>Back</Button>
            <Button
              variant="primary"
              appearance="danger"
              disabled={validEntries.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {`Import ${validEntries.length} ${meta.noun}${validEntries.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>

        <div className="results-counts">
          <Pill appearance="success" variant="muted">{`${counts.valid} to import`}</Pill>
          <Pill appearance={counts.collision > 0 ? 'warning' : 'info'} variant="muted">
            {`${counts.collision} already exist`}
          </Pill>
          <Pill appearance={counts.duplicate > 0 ? 'warning' : 'info'} variant="muted">
            {`${counts.duplicate} duplicate`}
          </Pill>
          <Pill appearance={counts.invalid > 0 ? 'danger' : 'info'} variant="muted">
            {`${counts.invalid} invalid`}
          </Pill>
        </div>

        <Alert
          appearance={validEntries.length === 0 ? 'danger' : 'warning'}
          title={
            validEntries.length === 0
              ? 'Nothing to import'
              : `Review before importing into “${groupLabel}”`
          }
        >
          {validEntries.length === 0
            ? `None of the uploaded files are valid, new ${meta.plural}. Fix the files or pick a different target, then try again.`
            : `${validEntries.length} valid ${meta.noun.toLowerCase()}${
                validEntries.length === 1 ? '' : 's'
              } will be created in worker group “${groupLabel}”, then the group is ${
                deployMode === 'commit-deploy' ? 'committed and deployed' : 'committed'
              }. Existing, duplicate, and invalid files are skipped (nothing is ever overwritten).`}
        </Alert>

        {validEntries.length > 0 && (
          <div className="form-grid">
            <label className="field">
              <Text variant="body-sm-semibold">After importing</Text>
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
        )}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>File</th>
                <th>{meta.noun} id</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {plan.map((r) => (
                <tr key={r.name} className={r.status === 'valid' ? undefined : 'row-invalid'}>
                  <td>
                    {r.status === 'valid' ? (
                      <Text variant="body-sm-normal" color="success">
                        {STATUS_LABEL[r.status]}
                      </Text>
                    ) : (
                      <Text variant="body-sm-normal" color="attention">
                        Skip — {STATUS_LABEL[r.status]}
                      </Text>
                    )}
                  </td>
                  <td>{r.name}</td>
                  <td>{r.id ? <Text variant="code">{r.id}</Text> : <span className="muted">—</span>}</td>
                  <td>
                    {r.error ? (
                      <Text variant="body-sm-normal" color="subtle">
                        <span className="mono">{r.error}</span>
                      </Text>
                    ) : (
                      <Text variant="body-sm-normal" color="subtle">
                        Ready to create
                      </Text>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Modal
          isOpen={confirmOpen}
          title={`Import ${validEntries.length} ${meta.noun}${validEntries.length === 1 ? '' : 's'}?`}
          confirmButtonText={`Import ${validEntries.length}`}
          cancelButtonText="Cancel"
          onConfirm={() => void runImport()}
          onClose={() => setConfirmOpen(false)}
        >
          <Text>
            This creates {validEntries.length} new {meta.noun.toLowerCase()}
            {validEntries.length === 1 ? '' : 's'} in worker group “{groupLabel}”, then{' '}
            {deployMode === 'commit-deploy' ? 'commits and deploys' : 'commits'} the group. Existing
            configs are never overwritten.
          </Text>
        </Modal>
      </div>
    );
  }

  // ---------- wizard ----------
  return (
    <div className="wf-section">
      <div className="wizard-steps" aria-hidden>
        {[1, 2, 3].map((n) => (
          <div
            key={n}
            className={`wizard-step${step === n ? ' wizard-step-active' : ''}${
              step > n ? ' wizard-step-done' : ''
            }`}
          >
            <span className="wizard-step-num">{n}</span>
            <span>{n === 1 ? 'Config type' : n === 2 ? 'Worker group' : 'Upload files'}</span>
          </div>
        ))}
      </div>

      {validateError && (
        <Alert appearance="danger" title="Could not validate files">
          {validateError}
        </Alert>
      )}

      {step === 1 && (
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            1. What are you importing?
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            One config type per import. Each file must contain a single {meta.noun.toLowerCase()}{' '}
            config (JSON).
          </Text>
          <RadioGroup
            aria-label="Config type"
            value={kind}
            onChange={(e) => setKind(e.target.value as ImportKind)}
          >
            {IMPORT_KINDS.map((k) => (
              <Radio key={k.kind} value={k.kind}>
                {`${k.noun}s`}
              </Radio>
            ))}
          </RadioGroup>
          <div className="wf-actions">
            <Button variant="primary" onClick={() => setStep(2)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            2. Target worker group
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            The {meta.plural} will be created in this group. Existing configs are never overwritten.
          </Text>
          <div className="form-grid">
            <label className="field">
              <Text variant="body-sm-semibold">Worker group</Text>
              <select
                className="native-select"
                aria-label="Target worker group"
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
          <div className="wf-actions">
            <Button onClick={() => setStep(1)}>Back</Button>
            <Button variant="primary" disabled={!groupId} onClick={() => setStep(3)}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            3. Upload {meta.noun.toLowerCase()} files
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            Drag and drop one or more <span className="mono">.json</span> files, or browse. Each
            file is one {meta.noun.toLowerCase()} config. Files are validated before anything is
            written.
          </Text>

          <div
            className={`dropzone${dragOver ? ' dropzone-active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            aria-label="Upload files"
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
          >
            <Text variant="body-sm-semibold">Drop .json files here</Text>
            <Text variant="body-sm-normal" color="subtle">
              or click to browse
            </Text>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files?.length) void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          {skippedNote && (
            <Text variant="body-sm-normal" color="attention">
              {skippedNote}
            </Text>
          )}

          {files.length > 0 && (
            <div className="file-list">
              {files.map((f) => (
                <div key={f.name} className="file-row">
                  <Text variant="code">{f.name}</Text>
                  <Button size="sm" appearance="danger" onClick={() => removeFile(f.name)}>
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="wf-actions">
            <Button onClick={() => setStep(2)}>Back</Button>
            <Button variant="primary" disabled={files.length === 0} onClick={() => void validate()}>
              {`Validate ${files.length} file${files.length === 1 ? '' : 's'}`}
            </Button>
            {files.length > 0 && (
              <Pill appearance="info" variant="muted">{`${files.length} file${
                files.length === 1 ? '' : 's'
              } ready`}</Pill>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface DeployStatus {
  attempted: boolean;
  deployRequested: boolean;
  committed: boolean;
  deployed: boolean;
  error?: string;
  note?: string;
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
        {deploy.error} The configs were created, but {where} was{' '}
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
        Committed and deployed the imported configs to {where}.
      </Alert>
    );
  }
  return (
    <Alert appearance="info" title="Committed">
      Committed the imported configs to {where}. Deploy the group to activate them.
    </Alert>
  );
}
