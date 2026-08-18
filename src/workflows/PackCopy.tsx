import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Pill, Spinner, Text, TextField } from '@capra/core';
import { CircleCheckFilled, CircleXFilled } from '@capra/icons';
import { isConnected } from '../api/client';
import { listWorkerGroups } from '../api/destinations';
import { exportPack, listGroupPacks } from '../api/packs';
import {
  commitWorkspaceGroup,
  deployWorkspaceGroup,
  installPack,
  listWorkspaceGroups,
  listWorkspacePacks,
  listWorkspaces,
  uploadPackFile,
} from '../api/managementPlane';
import {
  clearCredential,
  getStoredOrgId,
  hasStoredCredential,
  saveCredential,
} from '../api/credentials';
import { type PackInfo, type WorkerGroup, type WorkspaceInfo } from '../api/types';
import {
  buildCopyPlan,
  currentWorkspaceHost,
  deriveOrgId,
  packLabel,
  type CopyPlanItem,
} from '../lib/packCopy';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { ProgressBar } from '../components/ProgressBar';

type View = 'form' | 'preview' | 'running' | 'results';
type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type CredState = 'checking' | 'needed' | 'ready' | 'error';
type DeployMode = 'commit' | 'commit-deploy';

type PackStatus = 'copied' | 'skipped' | 'failed' | 'dryrun';
interface PackResult {
  id: string;
  label: string;
  sourceVersion?: string;
  existingVersion?: string;
  status: PackStatus;
  error?: string;
}

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

/** The platform proxy rejects any host not declared (exactly) in config/proxies.yml. */
const PROXY_NOT_DECLARED = /not declared in proxies\.yml/i;

/**
 * Persistent, up-front notice that Pack Copy is inert until the app has been built with the
 * destination workspaces declared in proxies.yml. Shown on the credential gate and at the top
 * of the form so users learn the requirement before investing time in the workflow.
 */
function RequiredSetupNotice() {
  return (
    <Alert appearance="info" title="Required setup — this workflow won't work until the app is built for your org">
      <Text variant="body-sm-normal">
        Copying packs to another workspace only works after an app admin has run the one-time build
        steps: generate the destination-workspace list, repackage, and reinstall the app. Until
        that's done, no destination workspaces will load below and copies will fail.
      </Text>
      <Text variant="body-sm-normal">
        Run <span className="mono">{'npm run proxies:gen -- --org <organizationId>'}</span>, then{' '}
        <span className="mono">npm run package</span> and reinstall the app. Full step-by-step
        instructions are in the README under “Declaring destination workspaces (required setup)”.
      </Text>
    </Alert>
  );
}

/**
 * Shown when a destination workspace's Leader host isn't in proxies.yml. Domain keys are
 * matched exactly (wildcards aren't supported), so each workspace must be declared at
 * build time. This tells the user what an app admin has to do to enable the workspace.
 */
function DomainNotDeclaredHelp({ fqdn }: { fqdn?: string }) {
  return (
    <Alert appearance="danger" title="This workspace isn't enabled for the current build">
      <Text variant="body-sm-normal">
        The app can only reach workspace hosts that are declared in its{' '}
        <span className="mono">proxies.yml</span> at build time — wildcards aren't supported — so
        this workspace's Leader{fqdn ? ' ' : ''}
        {fqdn ? <span className="mono">{fqdn}</span> : null} can't be reached yet.
      </Text>
      <Text variant="body-sm-normal">
        An app admin needs to add it and reinstall: run{' '}
        <span className="mono">{'npm run proxies:gen -- --org <organizationId>'}</span> to declare
        every workspace in the org (or add this one host by hand), then{' '}
        <span className="mono">npm run package</span> and reinstall the app. See the README section
        “Declaring destination workspaces”.
      </Text>
    </Alert>
  );
}

export function PackCopy() {
  const connected = isConnected();

  // --- credential gate ---
  const [credState, setCredState] = useState<CredState>('checking');
  const [credError, setCredError] = useState('');
  const [orgId, setOrgId] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [clearedNotice, setClearedNotice] = useState(false);

  // --- source (current workspace) ---
  const [srcGroups, setSrcGroups] = useState<WorkerGroup[]>([]);
  const [srcGroupsState, setSrcGroupsState] = useState<LoadState>('idle');
  const [srcGroupsError, setSrcGroupsError] = useState('');
  const [srcGroupId, setSrcGroupId] = useState('');
  const [srcPacks, setSrcPacks] = useState<PackInfo[]>([]);
  const [srcPacksState, setSrcPacksState] = useState<LoadState>('idle');
  const [srcPacksError, setSrcPacksError] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  // --- destination (another workspace) ---
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [wsState, setWsState] = useState<LoadState>('idle');
  const [wsError, setWsError] = useState('');
  const [destWsId, setDestWsId] = useState('');
  const [destGroups, setDestGroups] = useState<{ id: string; name?: string }[]>([]);
  const [destGroupsState, setDestGroupsState] = useState<LoadState>('idle');
  const [destGroupsError, setDestGroupsError] = useState('');
  const [destGroupId, setDestGroupId] = useState('');
  const [destPacks, setDestPacks] = useState<PackInfo[]>([]);
  const [destPacksState, setDestPacksState] = useState<LoadState>('idle');
  const [destPacksError, setDestPacksError] = useState('');

  const [deployMode, setDeployMode] = useState<DeployMode>('commit-deploy');
  const [dryRun, setDryRun] = useState(false);

  const [view, setView] = useState<View>('form');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<PackResult[]>([]);
  const [deployStatus, setDeployStatus] = useState<DeployStatus | null>(null);

  const currentHost = currentWorkspaceHost(window.CRIBL_API_URL);

  // Check for a stored credential once on mount.
  useEffect(() => {
    if (!connected) {
      setCredState('error');
      setCredError('This app must run inside Cribl to reach the API.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    hasStoredCredential(controller.signal)
      .then(async (has) => {
        if (cancelled) return;
        if (has) {
          const stored = await getStoredOrgId(controller.signal);
          if (cancelled) return;
          setOrgId(stored ?? '');
          setCredState('ready');
        } else {
          setCredState('needed');
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setCredState('error');
        setCredError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected]);

  // Source worker groups — loaded once credentials are ready.
  useEffect(() => {
    if (credState !== 'ready' || srcGroupsState !== 'idle') return;
    let cancelled = false;
    const controller = new AbortController();
    setSrcGroupsState('loading');
    setSrcGroupsError('');
    listWorkerGroups(controller.signal)
      .then((groups) => {
        if (cancelled) return;
        setSrcGroups(groups);
        setSrcGroupsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setSrcGroupsState('error');
        setSrcGroupsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credState]);

  // Organization workspaces — loaded once credentials are ready.
  useEffect(() => {
    if (credState !== 'ready' || wsState !== 'idle' || !orgId) return;
    let cancelled = false;
    const controller = new AbortController();
    setWsState('loading');
    setWsError('');
    listWorkspaces(orgId, controller.signal)
      .then((all) => {
        if (cancelled) return;
        setWorkspaces(all);
        setWsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setWsState('error');
        setWsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credState, orgId]);

  // Source packs for the selected source group.
  useEffect(() => {
    if (credState !== 'ready' || !srcGroupId) {
      setSrcPacks([]);
      setSrcPacksState('idle');
      setSelectedIds(new Set());
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setSrcPacksState('loading');
    setSrcPacksError('');
    setSelectedIds(new Set());
    listGroupPacks(srcGroupId, controller.signal)
      .then((packs) => {
        if (cancelled) return;
        setSrcPacks(packs);
        setSrcPacksState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setSrcPacksState('error');
        setSrcPacksError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [credState, srcGroupId]);

  const destWorkspace = workspaces.find((w) => w.workspaceId === destWsId);

  // Destination worker groups for the selected destination workspace.
  useEffect(() => {
    if (credState !== 'ready' || !destWorkspace) {
      setDestGroups([]);
      setDestGroupsState('idle');
      setDestGroupId('');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setDestGroupsState('loading');
    setDestGroupsError('');
    setDestGroupId('');
    listWorkspaceGroups(destWorkspace.leaderFQDN, controller.signal)
      .then((groups) => {
        if (cancelled) return;
        setDestGroups(groups);
        setDestGroupsState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setDestGroupsState('error');
        setDestGroupsError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credState, destWsId]);

  // Destination packs (for conflict detection) once a destination group is chosen.
  useEffect(() => {
    if (credState !== 'ready' || !destWorkspace || !destGroupId) {
      setDestPacks([]);
      setDestPacksState('idle');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setDestPacksState('loading');
    setDestPacksError('');
    listWorkspacePacks(destWorkspace.leaderFQDN, destGroupId, controller.signal)
      .then((packs) => {
        if (cancelled) return;
        setDestPacks(packs);
        setDestPacksState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setDestPacksState('error');
        setDestPacksError(toMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credState, destWsId, destGroupId]);

  // Destination workspaces the user can target: exclude the current one and any that
  // are not Active (their Leader API would be unreachable).
  const destOptions = useMemo(
    () =>
      workspaces.filter((w) => {
        const isCurrent = currentHost && w.leaderFQDN.toLowerCase() === currentHost;
        const usable = !w.state || w.state === 'Active';
        return !isCurrent && usable;
      }),
    [workspaces, currentHost],
  );

  const selectedPacks = useMemo(
    () => srcPacks.filter((p) => selectedIds.has(p.id)),
    [srcPacks, selectedIds],
  );

  const plan: CopyPlanItem[] = useMemo(
    () => buildCopyPlan(selectedPacks, destPacks),
    [selectedPacks, destPacks],
  );
  const copyable = plan.filter((p) => !p.conflict);
  const conflicts = plan.filter((p) => p.conflict);
  const allConflict = selectedPacks.length > 0 && copyable.length === 0;

  const destGroupLabel = useMemo(() => {
    const g = destGroups.find((x) => x.id === destGroupId);
    return g ? g.name || g.id : destGroupId;
  }, [destGroups, destGroupId]);
  const destWsLabel = destWorkspace
    ? destWorkspace.alias || destWorkspace.workspaceId
    : destWsId;
  const commitDeployVerb = deployMode === 'commit-deploy' ? 'committed and deployed' : 'committed';

  const destinationReady =
    !!destWorkspace &&
    destGroupsState === 'ready' &&
    !!destGroupId &&
    destPacksState === 'ready';

  const canPreview =
    credState === 'ready' &&
    srcGroupsState === 'ready' &&
    !!srcGroupId &&
    srcPacksState === 'ready' &&
    selectedPacks.length > 0 &&
    destinationReady &&
    !allConflict;

  function togglePack(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllPacks() {
    setSelectedIds(new Set(srcPacks.map((p) => p.id)));
  }
  function clearPackSelection() {
    setSelectedIds(new Set());
  }

  async function handleSaveCredential(cred: {
    orgId: string;
    clientId: string;
    clientSecret: string;
  }) {
    await saveCredential(cred);
    // Reset downstream selections so nothing points at the previous org.
    setDestWsId('');
    setWorkspaces([]);
    setWsState('idle');
    setOrgId(cred.orgId.trim());
    setClearedNotice(false);
    setSetupOpen(false);
    setCredState('ready');
  }

  async function finishAndClear() {
    try {
      await clearCredential();
    } catch {
      /* best-effort; the KV entries may already be gone */
    }
    // Wipe any org-scoped state so nothing lingers in the UI.
    setWorkspaces([]);
    setWsState('idle');
    setDestWsId('');
    setDestGroups([]);
    setDestGroupId('');
    setDestPacks([]);
    setOrgId('');
    setResults([]);
    setDeployStatus(null);
    setView('form');
    setClearedNotice(true);
    setCredState('needed');
  }

  async function runCopy() {
    setConfirmOpen(false);
    setView('running');
    setResults([]);
    setDeployStatus(null);

    if (!destWorkspace) return;
    const leaderFQDN = destWorkspace.leaderFQDN;
    const dstGroup = destGroupId;
    const total = plan.length;
    setProgress({ done: 0, total });

    const out: PackResult[] = [];
    let copied = 0;
    for (let i = 0; i < plan.length; i++) {
      const { pack, conflict, existingVersion } = plan[i];
      const base: PackResult = {
        id: pack.id,
        label: packLabel(pack),
        sourceVersion: pack.version,
        existingVersion,
        status: 'failed',
      };
      if (conflict) {
        out.push({ ...base, status: 'skipped' });
      } else if (dryRun) {
        out.push({ ...base, status: 'dryrun' });
      } else {
        try {
          const bytes = await exportPack(srcGroupId, pack.id);
          const source = await uploadPackFile(leaderFQDN, dstGroup, `${pack.id}.crbl`, bytes);
          await installPack(leaderFQDN, dstGroup, {
            id: pack.id,
            source,
            version: pack.version,
            displayName: pack.displayName,
            description: pack.description,
            author: pack.author,
          });
          out.push({ ...base, status: 'copied' });
          copied++;
        } catch (err) {
          out.push({ ...base, status: 'failed', error: toMessage(err) });
        }
      }
      setProgress({ done: i + 1, total });
    }
    setResults(out);

    // Commit (and optionally deploy) the destination group once, after the batch, so
    // the newly installed packs persist/activate. Only when something was installed.
    const wantDeploy = deployMode === 'commit-deploy';
    let deploy: DeployStatus = {
      attempted: false,
      deployRequested: wantDeploy,
      committed: false,
      deployed: false,
    };
    if (!dryRun && copied > 0) {
      deploy = { ...deploy, attempted: true };
      try {
        const hash = await commitWorkspaceGroup(
          leaderFQDN,
          dstGroup,
          `CC Cribl Power Tools: copied ${copied} pack${copied === 1 ? '' : 's'}`,
        );
        if (hash) {
          deploy = { ...deploy, committed: true };
          if (wantDeploy) {
            await deployWorkspaceGroup(leaderFQDN, dstGroup, hash);
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
    setView('form');
    setResults([]);
    setDeployStatus(null);
    setProgress({ done: 0, total: 0 });
    setSelectedIds(new Set());
  }

  // ---------- credential gate rendering ----------
  if (credState === 'checking') {
    return (
      <div className="wf-center">
        <Spinner title="Checking stored credentials…" />
      </div>
    );
  }

  if (credState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not start Pack Copy">
          {credError}
        </Alert>
      </div>
    );
  }

  if (credState === 'needed') {
    return (
      <div className="wf-section">
        <RequiredSetupNotice />
        {clearedNotice && (
          <Alert appearance="info" title="Stored credentials removed">
            The API Credential and cached token were deleted from this app's storage. For full
            hygiene, also disable or delete that credential in Cribl.Cloud (Organization → API
            Credentials).
          </Alert>
        )}
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            Connect your organization
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            Copying packs to another workspace uses Cribl.Cloud's management-plane API, which needs
            an Organization API Credential (Client ID + Secret). Set one up to continue.
          </Text>
          <div className="wf-actions">
            <Button variant="primary" onClick={() => setSetupOpen(true)}>
              Set up API credentials
            </Button>
          </div>
        </div>
        <SetupModal
          isOpen={setupOpen}
          defaultOrgId={orgId || deriveOrgId(window.CRIBL_API_URL)}
          defaultClientId=""
          onClose={() => setSetupOpen(false)}
          onSave={handleSaveCredential}
        />
      </div>
    );
  }

  // ---------- running ----------
  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          {dryRun ? 'Running dry run…' : 'Copying packs…'}
        </Text>
        <ProgressBar
          done={progress.done}
          total={progress.total}
          label={dryRun ? 'Packs checked' : 'Packs processed'}
        />
      </div>
    );
  }

  // ---------- results ----------
  if (view === 'results') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          Results
        </Text>
        <PackResultsView
          rows={results}
          deploy={deployStatus}
          destWsLabel={destWsLabel}
          destGroupLabel={destGroupLabel}
        />
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            Copy more packs?
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            If you're done, remove the stored API Credential from this app. You should also disable
            or delete it in Cribl.Cloud (Organization → API Credentials).
          </Text>
          <div className="wf-actions">
            <Button variant="primary" onClick={startOver}>
              Copy more packs
            </Button>
            <Button appearance="danger" onClick={() => void finishAndClear()}>
              No, I'm done — remove credentials
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- preview ----------
  if (view === 'preview') {
    return (
      <div className="wf-section">
        <div className="wf-actions wf-actions-between">
          <Text as="h2" variant="heading-md">
            Preview — {copyable.length} pack{copyable.length === 1 ? '' : 's'} to copy
            {conflicts.length > 0 ? `, ${conflicts.length} skipped` : ''}
          </Text>
          <div className="wf-actions">
            <Button onClick={() => setView('form')}>Back</Button>
            <Button
              variant="primary"
              appearance={dryRun ? 'default' : 'danger'}
              disabled={copyable.length === 0}
              onClick={() => (dryRun ? void runCopy() : setConfirmOpen(true))}
            >
              {dryRun ? 'Run dry run (no writes)' : `Copy ${copyable.length}`}
            </Button>
          </div>
        </div>

        <Alert
          appearance={dryRun ? 'info' : 'warning'}
          title={dryRun ? 'Dry run' : 'Review before copying'}
        >
          {dryRun
            ? `No packs will be written. ${copyable.length} pack${
                copyable.length === 1 ? '' : 's'
              } would be copied to worker group “${destGroupLabel}” in workspace “${destWsLabel}”.`
            : `Copying ${copyable.length} pack${
                copyable.length === 1 ? '' : 's'
              } into worker group “${destGroupLabel}” in workspace “${destWsLabel}”, then the group is ${commitDeployVerb}. Conflicting packs are skipped (never overwritten).`}
        </Alert>

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Pack</th>
                <th>Source version</th>
                <th>Destination</th>
              </tr>
            </thead>
            <tbody>
              {plan.map(({ pack, conflict, existingVersion }) => (
                <tr key={pack.id} className={conflict ? 'row-invalid' : undefined}>
                  <td>
                    {conflict ? (
                      <Text variant="body-sm-normal" color="attention">
                        Skip — exists{existingVersion ? ` (v${existingVersion})` : ''}
                      </Text>
                    ) : (
                      <Text variant="body-sm-normal" color="success">
                        Copy
                      </Text>
                    )}
                  </td>
                  <td>
                    <Text variant="code">{pack.id}</Text>
                    {pack.displayName && pack.displayName !== pack.id ? (
                      <div className="muted">{pack.displayName}</div>
                    ) : null}
                  </td>
                  <td>{pack.version || <span className="muted">—</span>}</td>
                  <td>
                    {destWsLabel} / {destGroupLabel}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <Modal
          isOpen={confirmOpen}
          title={`Copy ${copyable.length} pack${copyable.length === 1 ? '' : 's'}?`}
          confirmButtonText={`Copy ${copyable.length}`}
          cancelButtonText="Cancel"
          onConfirm={() => void runCopy()}
          onClose={() => setConfirmOpen(false)}
        >
          <Text>
            This copies {copyable.length} pack{copyable.length === 1 ? '' : 's'} into worker group “
            {destGroupLabel}” in workspace “{destWsLabel}”. The group's pending changes will then be{' '}
            {commitDeployVerb}.{conflicts.length > 0 ? ` ${conflicts.length} conflicting pack(s) will be skipped.` : ''}
          </Text>
        </Modal>
      </div>
    );
  }

  // ---------- form ----------
  return (
    <div className="wf-section">
      <div className="wf-toolbar">
        <div className="wf-toolbar-spacer" />
        <Button size="sm" onClick={() => setSetupOpen(true)}>
          Manage credentials
        </Button>
        <LabeledSwitch label="Dry run" checked={dryRun} onChange={setDryRun} />
      </div>

      <RequiredSetupNotice />

      <Alert appearance="warning" title="Organization credential is stored">
        This workflow holds a Cribl.Cloud API Credential in the app's storage to reach other
        workspaces. It must have <strong>Owner</strong> privileges (required to install and
        deploy packs in other workspaces), so it grants full org-wide API access and is shared by
        everyone who uses this app. Use a dedicated credential, and when you're done, remove it
        here and disable/delete it in Cribl.Cloud.
      </Alert>

      {/* Step 1 — source worker group */}
      <div className="lake-form">
        <Text as="h3" variant="heading-sm">
          1. Source worker group
        </Text>
        <Text variant="body-sm-normal" color="subtle">
          The worker group in this workspace to copy packs from.
        </Text>
        {srcGroupsState === 'loading' && (
          <div className="wf-actions">
            <Spinner title="Loading worker groups…" />
            <Text variant="body-sm-normal" color="subtle">
              Loading worker groups…
            </Text>
          </div>
        )}
        {srcGroupsState === 'error' && (
          <Alert appearance="danger" title="Could not load worker groups">
            {srcGroupsError}
          </Alert>
        )}
        {srcGroupsState === 'ready' && (
          <div className="form-grid">
            <label className="field">
              <Text variant="body-sm-semibold">Worker group</Text>
              <select
                className="native-select"
                aria-label="Source worker group"
                value={srcGroupId}
                onChange={(e) => setSrcGroupId(e.target.value)}
              >
                <option value="">Select a worker group…</option>
                {srcGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name || g.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Step 2 — packs */}
      {srcGroupId && (
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            2. Packs to copy
          </Text>
          {srcPacksState === 'loading' && (
            <div className="wf-actions">
              <Spinner title="Loading packs…" />
              <Text variant="body-sm-normal" color="subtle">
                Loading packs…
              </Text>
            </div>
          )}
          {srcPacksState === 'error' && (
            <Alert appearance="danger" title="Could not load packs">
              {srcPacksError}
            </Alert>
          )}
          {srcPacksState === 'ready' && srcPacks.length === 0 && (
            <Alert appearance="info" title="No packs">
              This worker group has no installed packs to copy.
            </Alert>
          )}
          {srcPacksState === 'ready' && srcPacks.length > 0 && (
            <>
              <div className="wf-actions">
                <Button size="sm" onClick={selectAllPacks}>
                  Select all
                </Button>
                <Button size="sm" onClick={clearPackSelection} disabled={selectedIds.size === 0}>
                  Clear
                </Button>
                <Pill appearance="info" variant="muted">{`${selectedIds.size} selected`}</Pill>
              </div>
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="col-check" />
                      <th>Pack id</th>
                      <th>Display name</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {srcPacks.map((p) => {
                      const checked = selectedIds.has(p.id);
                      return (
                        <tr key={p.id} className={checked ? 'row-selected' : undefined}>
                          <td className="col-check">
                            <input
                              type="checkbox"
                              aria-label={`Select ${p.id}`}
                              checked={checked}
                              onChange={() => togglePack(p.id)}
                            />
                          </td>
                          <td>
                            <Text variant="code">{p.id}</Text>
                          </td>
                          <td>{p.displayName || <span className="muted">—</span>}</td>
                          <td>{p.version || <span className="muted">—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Step 3 — destination workspace */}
      <div className="lake-form">
        <Text as="h3" variant="heading-sm">
          3. Destination workspace
        </Text>
        <Text variant="body-sm-normal" color="subtle">
          Another workspace in your organization (the current one is excluded). Each destination
          workspace must be declared in the app's <span className="mono">proxies.yml</span> at build
          time (wildcards aren't supported) — if a workspace's worker groups don't load, an app admin
          needs to add it via <span className="mono">npm run proxies:gen</span> and reinstall. See the
          README.
        </Text>
        {wsState === 'loading' && (
          <div className="wf-actions">
            <Spinner title="Loading workspaces…" />
            <Text variant="body-sm-normal" color="subtle">
              Loading workspaces…
            </Text>
          </div>
        )}
        {wsState === 'error' && (
          <Alert appearance="danger" title="Could not load workspaces">
            {wsError} Check the organization id and the API Credential (use “Manage credentials”).
          </Alert>
        )}
        {wsState === 'ready' && destOptions.length === 0 && (
          <Alert appearance="info" title="No other workspaces">
            No other Active workspaces were found in this organization.
          </Alert>
        )}
        {wsState === 'ready' && destOptions.length > 0 && (
          <div className="form-grid">
            <label className="field">
              <Text variant="body-sm-semibold">Workspace</Text>
              <select
                className="native-select"
                aria-label="Destination workspace"
                value={destWsId}
                onChange={(e) => setDestWsId(e.target.value)}
              >
                <option value="">Select a workspace…</option>
                {destOptions.map((w) => (
                  <option key={w.workspaceId} value={w.workspaceId}>
                    {w.alias ? `${w.alias} (${w.workspaceId})` : w.workspaceId}
                    {w.region ? ` — ${w.region}` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      {/* Step 4 — destination worker group */}
      {destWsId && (
        <div className="lake-form">
          <Text as="h3" variant="heading-sm">
            4. Destination worker group
          </Text>
          {destGroupsState === 'loading' && (
            <div className="wf-actions">
              <Spinner title="Loading worker groups…" />
              <Text variant="body-sm-normal" color="subtle">
                Loading worker groups…
              </Text>
            </div>
          )}
          {destGroupsState === 'error' &&
            (PROXY_NOT_DECLARED.test(destGroupsError) ? (
              <DomainNotDeclaredHelp fqdn={destWorkspace?.leaderFQDN} />
            ) : (
              <Alert appearance="danger" title="Could not load destination worker groups">
                {destGroupsError}
              </Alert>
            ))}
          {destGroupsState === 'ready' && destGroups.length === 0 && (
            <Alert appearance="info" title="No worker groups">
              The destination workspace has no Stream worker groups.
            </Alert>
          )}
          {destGroupsState === 'ready' && destGroups.length > 0 && (
            <div className="form-grid">
              <label className="field">
                <Text variant="body-sm-semibold">Worker group</Text>
                <select
                  className="native-select"
                  aria-label="Destination worker group"
                  value={destGroupId}
                  onChange={(e) => setDestGroupId(e.target.value)}
                >
                  <option value="">Select a worker group…</option>
                  {destGroups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name || g.id}
                    </option>
                  ))}
                </select>
                {destGroupId && destPacksState === 'loading' && (
                  <Text variant="body-sm-normal" color="subtle">
                    Checking installed packs…
                  </Text>
                )}
                {destGroupId && destPacksState === 'error' && (
                  <Text variant="body-sm-normal" color="attention">
                    Could not load installed packs: {destPacksError}
                  </Text>
                )}
              </label>

              <label className="field">
                <Text variant="body-sm-semibold">After copying</Text>
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
                    ? 'Copied packs are committed and deployed so they go live.'
                    : 'Copied packs are committed but not deployed — deploy the group yourself.'}
                </Text>
              </label>
            </div>
          )}
        </div>
      )}

      {/* Conflict summary + submit */}
      {destinationReady && selectedPacks.length > 0 && (
        <>
          {conflicts.length > 0 && (
            <Alert
              appearance={allConflict ? 'danger' : 'warning'}
              title={
                allConflict
                  ? 'All selected packs already exist in the destination'
                  : `${conflicts.length} pack${conflicts.length === 1 ? '' : 's'} will be skipped`
              }
            >
              {allConflict
                ? 'Every selected pack is already installed in the destination worker group. Nothing would be copied — pick different packs or a different destination.'
                : `These packs already exist in “${destGroupLabel}” and will be skipped (never overwritten): ${conflicts
                    .map((c) => `${c.pack.id}${c.existingVersion ? ` (v${c.existingVersion})` : ''}`)
                    .join(', ')}.`}
            </Alert>
          )}
        </>
      )}

      <div className="wf-actions">
        <Button variant="primary" disabled={!canPreview} onClick={() => setView('preview')}>
          {`Preview ${copyable.length} pack${copyable.length === 1 ? '' : 's'}`}
        </Button>
        {dryRun && (
          <Pill appearance="info" variant="muted">
            Dry run enabled
          </Pill>
        )}
        {selectedPacks.length > 0 && !destinationReady && (
          <Text variant="body-sm-normal" color="subtle">
            Select a destination workspace and worker group to continue.
          </Text>
        )}
      </div>

      <SetupModal
        isOpen={setupOpen}
        defaultOrgId={orgId || deriveOrgId(window.CRIBL_API_URL)}
        defaultClientId=""
        onClose={() => setSetupOpen(false)}
        onSave={handleSaveCredential}
      />
    </div>
  );
}

/** Credential setup / management modal. */
function SetupModal({
  isOpen,
  defaultOrgId,
  defaultClientId,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  defaultOrgId: string;
  defaultClientId: string;
  onClose: () => void;
  onSave: (cred: { orgId: string; clientId: string; clientSecret: string }) => Promise<void>;
}) {
  const [orgId, setOrgId] = useState(defaultOrgId);
  const [clientId, setClientId] = useState(defaultClientId);
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reset fields whenever the modal opens with fresh defaults.
  useEffect(() => {
    if (isOpen) {
      setOrgId(defaultOrgId);
      setClientId(defaultClientId);
      setClientSecret('');
      setError('');
      setSaving(false);
    }
  }, [isOpen, defaultOrgId, defaultClientId]);

  const valid = orgId.trim() && clientId.trim() && clientSecret.trim();

  async function save() {
    if (!valid) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ orgId, clientId, clientSecret });
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      title="Organization API credentials"
      confirmButtonText={saving ? 'Saving…' : 'Save credentials'}
      cancelButtonText="Cancel"
      onConfirm={() => void save()}
      onClose={onClose}
    >
      <div className="lake-form" style={{ border: 'none', padding: 0, background: 'none' }}>
        <Alert appearance="warning" title="Security notice">
          This API Credential must have <strong>Owner</strong> privileges — copying packs across
          workspaces (listing workspaces, installing packs, and committing/deploying in the
          destination) requires org-Owner access, so a least-privilege credential will not work.
          Because it grants full org-wide access to the Cribl.Cloud management API and is stored in
          this app's shared storage, use a dedicated credential and disable or delete it in
          Cribl.Cloud (Organization → API Credentials) once you've finished copying packs.
        </Alert>
        <Text variant="body-sm-normal" color="subtle">
          Create the credential in Cribl.Cloud under Organization → API Credentials, then paste its
          Client ID and Secret here.
        </Text>
        <label className="field">
          <Text variant="body-sm-semibold">Organization ID</Text>
          <TextField aria-label="Organization ID" value={orgId} onChange={setOrgId} />
        </label>
        <label className="field">
          <Text variant="body-sm-semibold">Client ID</Text>
          <TextField aria-label="Client ID" value={clientId} onChange={setClientId} />
        </label>
        <label className="field">
          <Text variant="body-sm-semibold">Client Secret</Text>
          <TextField
            type="password"
            aria-label="Client Secret"
            value={clientSecret}
            onChange={setClientSecret}
          />
        </label>
        {error && (
          <Text variant="body-sm-normal" color="attention">
            {error}
          </Text>
        )}
      </div>
    </Modal>
  );
}

/** Per-pack copied/skipped/failed report plus the destination commit/deploy outcome. */
function PackResultsView({
  rows,
  deploy,
  destWsLabel,
  destGroupLabel,
}: {
  rows: PackResult[];
  deploy: DeployStatus | null;
  destWsLabel: string;
  destGroupLabel: string;
}) {
  const copied = rows.filter((r) => r.status === 'copied').length;
  const skipped = rows.filter((r) => r.status === 'skipped').length;
  const failed = rows.filter((r) => r.status === 'failed').length;
  const anyDryRun = rows.some((r) => r.status === 'dryrun');

  return (
    <div className="results">
      <div className="results-counts">
        <Pill appearance="success" variant="muted">{`${copied} copied`}</Pill>
        <Pill appearance={skipped > 0 ? 'warning' : 'info'} variant="muted">{`${skipped} skipped`}</Pill>
        <Pill appearance={failed > 0 ? 'danger' : 'info'} variant="muted">{`${failed} failed`}</Pill>
        {anyDryRun && (
          <Pill appearance="info" variant="muted">
            Dry run — no changes were written
          </Pill>
        )}
      </div>

      <CommitDeployAlert
        deploy={deploy}
        destWsLabel={destWsLabel}
        destGroupLabel={destGroupLabel}
      />

      <Text as="h3" variant="heading-sm">
        Packs → “{destGroupLabel}” in “{destWsLabel}”
      </Text>
      <table className="data-table results-table">
        <thead>
          <tr>
            <th className="col-status">Status</th>
            <th>Pack</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="col-status">
                <PackStatusIcon status={r.status} />
              </td>
              <td>
                <Text variant="code">{r.id}</Text>
              </td>
              <td>
                <PackResultDetail row={r} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommitDeployAlert({
  deploy,
  destWsLabel,
  destGroupLabel,
}: {
  deploy: DeployStatus | null;
  destWsLabel: string;
  destGroupLabel: string;
}) {
  if (!deploy?.attempted) return null;
  const where = `worker group “${destGroupLabel}” in “${destWsLabel}”`;
  if (deploy.error) {
    return (
      <Alert appearance="danger" title={deploy.committed ? 'Deploy failed' : 'Commit failed'}>
        {deploy.error} The packs were copied, but {where} was{' '}
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
      <Alert appearance="info" title="Destination committed and deployed">
        Committed and deployed the copied packs to {where}.
      </Alert>
    );
  }
  return (
    <Alert appearance="info" title="Destination committed">
      Committed the copied packs to {where}. Deploy the group to activate them.
    </Alert>
  );
}

function PackStatusIcon({ status }: { status: PackStatus }) {
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
    <span className="status-ok" aria-label={status === 'dryrun' ? 'would be copied' : 'copied'}>
      <CircleCheckFilled />
    </span>
  );
}

function PackResultDetail({ row }: { row: PackResult }) {
  if (row.status === 'failed') {
    return (
      <Text variant="body-sm-normal" color="attention">
        <span className="mono">{row.error ?? 'Unknown error'}</span>
      </Text>
    );
  }
  if (row.status === 'skipped') {
    return (
      <Text variant="body-sm-normal" color="subtle">
        Already exists{row.existingVersion ? ` (v${row.existingVersion})` : ''} — skipped
      </Text>
    );
  }
  const verb = row.status === 'dryrun' ? 'Would be copied (dry run)' : 'Copied';
  return (
    <Text variant="body-sm-normal" color="subtle">
      {verb}
      {row.sourceVersion ? ` — v${row.sourceVersion}` : ''}
    </Text>
  );
}
