import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Modal,
  Pill,
  Radio,
  RadioGroup,
  Spinner,
  Tag,
  Text,
  TextField,
} from '@capra/core';
import { EditOutlined } from '@capra/icons';
import {
  applyDatasetTeamAcl,
  applyDatasetUserAcl,
  buildDatasetUpdateBody,
  getDatasetTeamAcl,
  getDatasetUserAcl,
  listBreakerRulesets,
  listSearchDatasets,
  listTeams,
  listUsers,
  updateSearchDataset,
} from '../api/search';
import { isConnected } from '../api/client';
import type {
  AccessControl,
  AccessControlSchema,
  SearchDataset,
  UserAccessControlList,
} from '../api/types';
import type { Option } from '../components/OrderedListEditor';
import { mapWithConcurrency } from '../lib/concurrency';
import { runBatch, type BatchItemResult } from '../lib/batch';
import { LabeledSwitch } from '../components/LabeledSwitch';
import { OrderedListEditor } from '../components/OrderedListEditor';
import { ProgressBar } from '../components/ProgressBar';
import { ResultsSummary, type ResultRow } from '../components/ResultsSummary';

type SubjectType = 'user' | 'team';
type ShareMode = 'add' | 'replace';
type DatatypeMode = 'replace' | 'append';
type SortKey = 'id' | 'description' | 'provider';
type View = 'table' | 'preview' | 'running' | 'results';

interface Grant {
  key: string;
  subjectType: SubjectType;
  subjectId: string;
  policy: string;
}

interface AclEntry {
  users?: UserAccessControlList[];
  teams?: UserAccessControlList[];
  loading: boolean;
  error?: string;
}

let grantSeq = 0;

// --- pure helpers -----------------------------------------------------------

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function computeNextRulesets(current: string[], additions: string[], mode: DatatypeMode): string[] {
  return mode === 'replace' ? [...additions] : dedupe([...current, ...additions]);
}

/** subjectId -> set of policy strings, from the ACL list of one subject type. */
function toSubjectPolicyMap(list: UserAccessControlList[] | undefined): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const entry of list ?? []) {
    const set = map.get(entry.user) ?? new Set<string>();
    for (const p of entry.perms) if (p.policy) set.add(p.policy);
    map.set(entry.user, set);
  }
  return map;
}

function grantsToMap(grants: Grant[], type: SubjectType): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const g of grants) {
    if (g.subjectType !== type) continue;
    if (!g.subjectId.trim() || !g.policy.trim()) continue;
    const set = map.get(g.subjectId) ?? new Set<string>();
    set.add(g.policy);
    map.set(g.subjectId, set);
  }
  return map;
}

/** Diff current vs desired into an AccessControl add/rm payload. */
function buildAclSchema(
  current: Map<string, Set<string>>,
  desired: Map<string, Set<string>>,
  mode: ShareMode,
): AccessControlSchema {
  const add: AccessControl = {};
  const rm: AccessControl = {};

  for (const [subject, policies] of desired) {
    const have = current.get(subject) ?? new Set<string>();
    const missing = [...policies].filter((p) => !have.has(p));
    if (missing.length) add[subject] = missing;
  }

  if (mode === 'replace') {
    for (const [subject, policies] of current) {
      const want = desired.get(subject) ?? new Set<string>();
      const extra = [...policies].filter((p) => !want.has(p));
      if (extra.length) rm[subject] = extra;
    }
  }

  const schema: AccessControlSchema = {};
  if (Object.keys(add).length) schema.add = add;
  if (Object.keys(rm).length) schema.rm = rm;
  return schema;
}

function aclHasChanges(schema: AccessControlSchema): boolean {
  return Boolean(schema.add || schema.rm);
}

function subjectSummary(entry: AclEntry | undefined): { users: number; teams: number } {
  return {
    users: entry?.users?.length ?? 0,
    teams: entry?.teams?.length ?? 0,
  };
}

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- component --------------------------------------------------------------

export function SearchBulkEdit() {
  const connected = isConnected();

  const [datasets, setDatasets] = useState<SearchDataset[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [loadError, setLoadError] = useState('');
  const [aclMap, setAclMap] = useState<Record<string, AclEntry>>({});

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [filterText, setFilterText] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({
    key: 'id',
    dir: 'asc',
  });

  const [dryRun, setDryRun] = useState(false);

  const [editShare, setEditShare] = useState(false);
  const [shareMode, setShareMode] = useState<ShareMode>('add');
  const [grants, setGrants] = useState<Grant[]>([]);

  const [editDatatypes, setEditDatatypes] = useState(false);
  const [datatypeMode, setDatatypeMode] = useState<DatatypeMode>('replace');
  const [rulesets, setRulesets] = useState<string[]>([]);

  // Pickers: available rulesets, users, and teams (loaded once, best-effort).
  const [rulesetOptions, setRulesetOptions] = useState<Option[]>([]);
  const [userOptions, setUserOptions] = useState<Option[]>([]);
  const [teamOptions, setTeamOptions] = useState<Option[]>([]);

  const [view, setView] = useState<View>('table');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<ResultRow[]>([]);

  // Load datasets + prefetch ACLs.
  useEffect(() => {
    if (!connected) {
      setLoadState('error');
      setLoadError('This app must run inside Cribl to load Search datasets.');
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoadState('loading');
    listSearchDatasets(controller.signal)
      .then((rows) => {
        if (cancelled) return;
        setDatasets(rows);
        setLoadState('ready');
        void prefetchAcls(rows, controller.signal);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // Load picker options (rulesets, users, teams). Best-effort: a failure here just
  // leaves the corresponding picker empty and does not block the datasets table.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const controller = new AbortController();
    listBreakerRulesets(controller.signal)
      .then((items) => {
        if (cancelled) return;
        setRulesetOptions(
          items.map((r) => ({
            value: r.id,
            label: r.description ? `${r.id} — ${r.description}` : r.id,
          })),
        );
      })
      .catch(() => {});
    listUsers(controller.signal)
      .then((items) => {
        if (cancelled) return;
        setUserOptions(
          items.map((u) => {
            const full = [u.first, u.last].filter(Boolean).join(' ').trim();
            const name = full || u.username || u.id;
            return { value: u.id, label: name === u.id ? u.id : `${name} (${u.id})` };
          }),
        );
      })
      .catch(() => {});
    listTeams(controller.signal)
      .then((items) => {
        if (cancelled) return;
        setTeamOptions(
          items.map((t) => ({ value: t.id, label: t.name ? `${t.name} (${t.id})` : t.id })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [connected]);

  async function prefetchAcls(rows: SearchDataset[], signal: AbortSignal) {
    setAclMap((prev) => {
      const next = { ...prev };
      for (const d of rows) next[d.id] = { loading: true };
      return next;
    });
    await mapWithConcurrency(rows, 6, async (d) => {
      try {
        const [users, teams] = await Promise.all([
          getDatasetUserAcl(d.id, signal),
          getDatasetTeamAcl(d.id, signal),
        ]);
        if (signal.aborted) return;
        setAclMap((prev) => ({ ...prev, [d.id]: { users, teams, loading: false } }));
      } catch (err) {
        if (signal.aborted) return;
        setAclMap((prev) => ({ ...prev, [d.id]: { loading: false, error: toMessage(err) } }));
      }
    });
  }

  const providers = useMemo(
    () => [...new Set(datasets.map((d) => d.provider).filter(Boolean))].sort(),
    [datasets],
  );

  const filtered = useMemo(() => {
    const q = filterText.trim().toLowerCase();
    const rows = datasets.filter((d) => {
      if (providerFilter && d.provider !== providerFilter) return false;
      if (!q) return true;
      return (
        d.id.toLowerCase().includes(q) ||
        (d.description ?? '').toLowerCase().includes(q) ||
        d.provider.toLowerCase().includes(q)
      );
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = String(a[sort.key] ?? '').toLowerCase();
      const bv = String(b[sort.key] ?? '').toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }, [datasets, filterText, providerFilter, sort]);

  const selectedDatasets = useMemo(
    () => datasets.filter((d) => selection.has(d.id)),
    [datasets, selection],
  );

  const policySuggestions = useMemo(() => {
    const set = new Set<string>();
    for (const entry of Object.values(aclMap)) {
      for (const list of [entry.users, entry.teams]) {
        for (const u of list ?? []) for (const p of u.perms) if (p.policy) set.add(p.policy);
      }
    }
    return [...set].sort();
  }, [aclMap]);

  const subjectSuggestions = useMemo(() => {
    const users = new Set<string>();
    const teams = new Set<string>();
    for (const entry of Object.values(aclMap)) {
      for (const u of entry.users ?? []) users.add(u.user);
      for (const t of entry.teams ?? []) teams.add(t.user);
    }
    return { users: [...users].sort(), teams: [...teams].sort() };
  }, [aclMap]);

  // --- selection helpers ----
  const allFilteredSelected = filtered.length > 0 && filtered.every((d) => selection.has(d.id));
  const someFilteredSelected = filtered.some((d) => selection.has(d.id));

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
      if (allFilteredSelected) filtered.forEach((d) => next.delete(d.id));
      else filtered.forEach((d) => next.add(d.id));
      return next;
    });
  }
  function selectAll() {
    setSelection(new Set(datasets.map((d) => d.id)));
  }
  function clearSelection() {
    setSelection(new Set());
  }

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  // --- grants editor ----
  function addGrant() {
    setGrants((prev) => [
      ...prev,
      { key: `g${grantSeq++}`, subjectType: 'user', subjectId: '', policy: '' },
    ]);
  }
  function updateGrant(key: string, patch: Partial<Grant>) {
    setGrants((prev) => prev.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  }
  function removeGrant(key: string) {
    setGrants((prev) => prev.filter((g) => g.key !== key));
  }

  const shareReady =
    editShare && grants.some((g) => g.subjectId.trim() && g.policy.trim());
  const datatypesReady = editDatatypes && (datatypeMode === 'replace' || rulesets.length > 0);
  const canPreview =
    selection.size > 0 && (shareReady || datatypesReady) && loadState === 'ready';

  // Ensure ACLs for selected datasets are loaded before previewing/applying sharing.
  async function ensureSelectedAcls(): Promise<boolean> {
    if (!editShare) return true;
    const missing = selectedDatasets.filter((d) => {
      const e = aclMap[d.id];
      return !e || (e.loading && !e.users);
    });
    if (missing.length === 0) return true;
    const controller = new AbortController();
    await mapWithConcurrency(missing, 6, async (d) => {
      try {
        const [users, teams] = await Promise.all([
          getDatasetUserAcl(d.id, controller.signal),
          getDatasetTeamAcl(d.id, controller.signal),
        ]);
        setAclMap((prev) => ({ ...prev, [d.id]: { users, teams, loading: false } }));
      } catch (err) {
        setAclMap((prev) => ({ ...prev, [d.id]: { loading: false, error: toMessage(err) } }));
      }
    });
    return true;
  }

  async function goToPreview() {
    await ensureSelectedAcls();
    setView('preview');
  }

  // --- apply ----
  async function applyToDataset(ds: SearchDataset): Promise<void> {
    if (editDatatypes) {
      const current = Array.isArray(ds.breakerRulesets) ? ds.breakerRulesets : [];
      const next = computeNextRulesets(current, rulesets, datatypeMode);
      try {
        await updateSearchDataset(buildDatasetUpdateBody(ds, next));
      } catch (err) {
        throw new Error(`Datatype rulesets update failed: ${toMessage(err)}`);
      }
    }
    if (editShare) {
      const entry = aclMap[ds.id];
      const userSchema = buildAclSchema(
        toSubjectPolicyMap(entry?.users),
        grantsToMap(grants, 'user'),
        shareMode,
      );
      const teamSchema = buildAclSchema(
        toSubjectPolicyMap(entry?.teams),
        grantsToMap(grants, 'team'),
        shareMode,
      );
      try {
        if (aclHasChanges(userSchema)) await applyDatasetUserAcl(ds.id, userSchema);
      } catch (err) {
        throw new Error(`User share update failed: ${toMessage(err)}`);
      }
      try {
        if (aclHasChanges(teamSchema)) await applyDatasetTeamAcl(ds.id, teamSchema);
      } catch (err) {
        throw new Error(`Team share update failed: ${toMessage(err)}`);
      }
    }
  }

  async function runApply() {
    setConfirmOpen(false);
    setView('running');
    setProgress({ done: 0, total: selectedDatasets.length });
    setResults([]);
    const batch = await runBatch(
      selectedDatasets,
      applyToDataset,
      (p) => setProgress({ done: p.done, total: p.total }),
      { dryRun },
    );
    setResults(batch.map(toResultRow));
    setView('results');
  }

  function toResultRow(r: BatchItemResult<SearchDataset>): ResultRow {
    return { label: r.item.id, ok: r.ok, error: r.error, dryRun: r.dryRun };
  }

  function startOver() {
    setView('table');
    setResults([]);
    setProgress({ done: 0, total: 0 });
  }

  // --- render ----
  if (loadState === 'loading' || loadState === 'idle') {
    return (
      <div className="wf-center">
        <Spinner title="Loading Search datasets…" />
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="wf-section">
        <Alert appearance="danger" title="Could not load Search datasets">
          {loadError}
        </Alert>
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="wf-section">
        <Text as="h2" variant="heading-md">
          {dryRun ? 'Running dry run…' : 'Applying changes…'}
        </Text>
        <ProgressBar
          done={progress.done}
          total={progress.total}
          label={dryRun ? 'Datasets validated' : 'Datasets updated'}
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
        <ResultsSummary noun="dataset" rows={results} />
        <div className="wf-actions">
          <Button variant="primary" onClick={startOver}>
            Back to datasets
          </Button>
        </div>
      </div>
    );
  }

  if (view === 'preview') {
    return (
      <PreviewScreen
        datasets={selectedDatasets}
        aclMap={aclMap}
        editDatatypes={editDatatypes}
        datatypeMode={datatypeMode}
        rulesets={rulesets}
        editShare={editShare}
        shareMode={shareMode}
        grants={grants}
        dryRun={dryRun}
        onBack={() => setView('table')}
        onApply={() => (dryRun ? void runApply() : setConfirmOpen(true))}
        confirmOpen={confirmOpen}
        onConfirm={() => void runApply()}
        onConfirmClose={() => setConfirmOpen(false)}
      />
    );
  }

  // --- table view ----
  return (
    <div className="wf-section">
      <div className="wf-toolbar">
        <TextField
          aria-label="Filter datasets"
          placeholder="Filter by id, description, or provider"
          value={filterText}
          onChange={setFilterText}
        />
        <select
          className="native-select"
          aria-label="Filter by provider"
          value={providerFilter}
          onChange={(e) => setProviderFilter(e.target.value)}
        >
          <option value="">All providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <div className="wf-toolbar-spacer" />
        <LabeledSwitch label="Dry run" checked={dryRun} onChange={setDryRun} />
      </div>

      <div className="wf-selectbar">
        <Text variant="body-sm-normal" color="subtle">
          {selection.size} selected · {filtered.length} shown · {datasets.length} total
        </Text>
        <div className="wf-selectbar-actions">
          <Button size="sm" onClick={toggleAllFiltered} disabled={filtered.length === 0}>
            {allFilteredSelected ? 'Deselect filtered' : 'Select filtered'}
          </Button>
          <Button size="sm" onClick={selectAll} disabled={datasets.length === 0}>
            {`Select all ${datasets.length}`}
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
              <SortableTh label="Dataset ID" active={sort} col="id" onSort={toggleSort} />
              <SortableTh
                label="Description"
                active={sort}
                col="description"
                onSort={toggleSort}
              />
              <SortableTh label="Provider" active={sort} col="provider" onSort={toggleSort} />
              <th>Datatype rulesets</th>
              <th>Share permissions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((d) => {
              const rs = Array.isArray(d.breakerRulesets) ? d.breakerRulesets : [];
              const entry = aclMap[d.id];
              const { users, teams } = subjectSummary(entry);
              return (
                <tr key={d.id} className={selection.has(d.id) ? 'row-selected' : undefined}>
                  <td className="col-check">
                    <Checkbox
                      aria-label={`Select ${d.id}`}
                      checked={selection.has(d.id)}
                      onChange={() => toggleOne(d.id)}
                    />
                  </td>
                  <td>
                    <Text variant="code">{d.id}</Text>
                  </td>
                  <td>{d.description || <span className="muted">—</span>}</td>
                  <td>
                    <Text variant="code">{d.provider}</Text>
                  </td>
                  <td>
                    {rs.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      <div className="tag-row">
                        {rs.map((r, i) => (
                          <Tag key={`${r}-${i}`} color="default" size="sm">
                            {r}
                          </Tag>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    {!entry || entry.loading ? (
                      <Spinner size="sm" />
                    ) : entry.error ? (
                      <span className="muted" title={entry.error}>
                        unavailable
                      </span>
                    ) : users + teams === 0 ? (
                      <span className="muted">Not shared</span>
                    ) : (
                      <Text variant="body-sm-normal">
                        {users} user{users === 1 ? '' : 's'} · {teams} team
                        {teams === 1 ? '' : 's'}
                      </Text>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="wf-empty">
            <Text color="subtle">No datasets match the current filter.</Text>
          </div>
        )}
      </div>

      {/* Edit panel */}
      <div className="edit-panel">
        <Text as="h3" variant="heading-sm">
          Bulk edits
        </Text>
        <Text variant="body-sm-normal" color="subtle">
          Enable either edit (or both). Changes apply uniformly to all {selection.size} selected
          dataset{selection.size === 1 ? '' : 's'}.
        </Text>

        {/* Datatypes */}
        <div className="edit-block">
          <LabeledSwitch
            label="Update datatype rulesets"
            checked={editDatatypes}
            onChange={setEditDatatypes}
          />
          {editDatatypes && (
            <div className="edit-body">
              <RadioGroup
                aria-label="Datatype ruleset mode"
                value={datatypeMode}
                onChange={(e) => setDatatypeMode(e.target.value as DatatypeMode)}
                layout="horizontal"
              >
                <Radio value="replace">Replace existing</Radio>
                <Radio value="append">Append to existing</Radio>
              </RadioGroup>
              <Text variant="body-sm-normal" color="subtle">
                {datatypeMode === 'replace'
                  ? 'The dataset breakerRulesets will be set to exactly this ordered list.'
                  : 'These rulesets will be appended (de-duplicated) after each dataset’s existing rulesets.'}
              </Text>
              <OrderedListEditor
                value={rulesets}
                onChange={setRulesets}
                placeholder={rulesetOptions.length ? 'Select a ruleset…' : 'Ruleset ID'}
                addLabel="Add ruleset"
                options={rulesetOptions.length ? rulesetOptions : undefined}
                emptyOptionsLabel="All available rulesets added"
              />
            </div>
          )}
        </div>

        {/* Sharing */}
        <div className="edit-block">
          <LabeledSwitch
            label="Update share permissions"
            checked={editShare}
            onChange={setEditShare}
          />
          {editShare && (
            <div className="edit-body">
              <RadioGroup
                aria-label="Share mode"
                value={shareMode}
                onChange={(e) => setShareMode(e.target.value as ShareMode)}
                layout="horizontal"
              >
                <Radio value="add">Add / merge grants</Radio>
                <Radio value="replace">Replace all grants</Radio>
              </RadioGroup>
              <Text variant="body-sm-normal" color="subtle">
                {shareMode === 'add'
                  ? 'Listed grants are added on top of each dataset’s current sharing.'
                  : 'Each dataset will be shared with exactly the listed grants; other existing grants are removed.'}
              </Text>

              {grants.length === 0 && (
                <Text variant="body-sm-normal" color="subtle">
                  No grants yet.
                </Text>
              )}
              {grants.map((g) => (
                <div key={g.key} className="grant-row">
                  <select
                    className="native-select"
                    aria-label="Subject type"
                    value={g.subjectType}
                    onChange={(e) =>
                      updateGrant(g.key, {
                        subjectType: e.target.value as SubjectType,
                        subjectId: '',
                      })
                    }
                  >
                    <option value="user">User</option>
                    <option value="team">Team</option>
                  </select>
                  {(() => {
                    const opts = g.subjectType === 'user' ? userOptions : teamOptions;
                    // Prefer a dropdown of known subjects; fall back to free text if the
                    // list could not be loaded.
                    return opts.length > 0 ? (
                      <select
                        className="native-select"
                        aria-label="Subject"
                        value={g.subjectId}
                        onChange={(e) => updateGrant(g.key, { subjectId: e.target.value })}
                      >
                        <option value="" disabled>
                          {g.subjectType === 'user' ? 'Select a user…' : 'Select a team…'}
                        </option>
                        {opts.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="native-input"
                        aria-label="Subject id"
                        placeholder={g.subjectType === 'user' ? 'user id' : 'team id'}
                        list={`subjects-${g.subjectType}`}
                        value={g.subjectId}
                        onChange={(e) => updateGrant(g.key, { subjectId: e.target.value })}
                      />
                    );
                  })()}
                  <input
                    className="native-input"
                    aria-label="Permission policy"
                    placeholder="permission (policy)"
                    list="policy-suggestions"
                    value={g.policy}
                    onChange={(e) => updateGrant(g.key, { policy: e.target.value })}
                  />
                  <Button size="sm" appearance="danger" onClick={() => removeGrant(g.key)}>
                    Remove
                  </Button>
                </div>
              ))}
              <datalist id="subjects-user">
                {subjectSuggestions.users.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <datalist id="subjects-team">
                {subjectSuggestions.teams.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <datalist id="policy-suggestions">
                {policySuggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <div>
                <Button size="sm" onClick={addGrant}>
                  Add grant
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="wf-actions">
          <Button
            variant="primary"
            leadingIcon={EditOutlined}
            disabled={!canPreview}
            onClick={() => void goToPreview()}
          >
            Preview changes
          </Button>
          {dryRun && (
            <Pill appearance="info" variant="muted">
              Dry run enabled
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}

// --- small subcomponents ----------------------------------------------------

function SortableTh({
  label,
  col,
  active,
  onSort,
}: {
  label: string;
  col: SortKey;
  active: { key: SortKey; dir: 'asc' | 'desc' };
  onSort: (c: SortKey) => void;
}) {
  const arrow = active.key === col ? (active.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th>
      <button type="button" className="th-sort" onClick={() => onSort(col)}>
        {label}
        {arrow}
      </button>
    </th>
  );
}

interface PreviewProps {
  datasets: SearchDataset[];
  aclMap: Record<string, AclEntry>;
  editDatatypes: boolean;
  datatypeMode: DatatypeMode;
  rulesets: string[];
  editShare: boolean;
  shareMode: ShareMode;
  grants: Grant[];
  dryRun: boolean;
  onBack: () => void;
  onApply: () => void;
  confirmOpen: boolean;
  onConfirm: () => void;
  onConfirmClose: () => void;
}

function PreviewScreen(props: PreviewProps) {
  const {
    datasets,
    aclMap,
    editDatatypes,
    datatypeMode,
    rulesets,
    editShare,
    shareMode,
    grants,
    dryRun,
    onBack,
    onApply,
    confirmOpen,
    onConfirm,
    onConfirmClose,
  } = props;

  const desiredUsers = grantsToMap(grants, 'user');
  const desiredTeams = grantsToMap(grants, 'team');

  function resultingShare(
    current: Map<string, Set<string>>,
    overlay: Map<string, Set<string>>,
  ): Map<string, Set<string>> {
    // In "add" mode start from current sharing; in "replace" mode start empty.
    const result =
      shareMode === 'add'
        ? new Map<string, Set<string>>([...current].map(([s, ps]) => [s, new Set(ps)]))
        : new Map<string, Set<string>>();
    for (const [s, ps] of overlay) {
      const set = new Set(result.get(s) ?? []);
      for (const p of ps) set.add(p);
      result.set(s, set);
    }
    return result;
  }

  return (
    <div className="wf-section">
      <div className="wf-actions wf-actions-between">
        <Text as="h2" variant="heading-md">
          Preview — {datasets.length} dataset{datasets.length === 1 ? '' : 's'}
        </Text>
        <div className="wf-actions">
          <Button onClick={onBack}>Back</Button>
          <Button variant="primary" appearance={dryRun ? 'default' : 'danger'} onClick={onApply}>
            {dryRun ? 'Run dry run (no writes)' : `Apply to ${datasets.length}`}
          </Button>
        </div>
      </div>

      <Alert appearance={dryRun ? 'info' : 'warning'} title={dryRun ? 'Dry run' : 'Review before applying'}>
        {dryRun
          ? 'No write calls will be made. This shows exactly what would change.'
          : 'Applying will PATCH datatype rulesets and/or modify share ACLs on each dataset below.'}
      </Alert>

      <div className="preview-list">
        {datasets.map((d) => {
          const currentRs = Array.isArray(d.breakerRulesets) ? d.breakerRulesets : [];
          const nextRs = computeNextRulesets(currentRs, rulesets, datatypeMode);
          const entry = aclMap[d.id];
          return (
            <div key={d.id} className="preview-card">
              <Text variant="code">{d.id}</Text>

              {editDatatypes && (
                <div className="preview-field">
                  <Text variant="body-sm-semibold">Datatype rulesets</Text>
                  <DiffRow before={currentRs} after={nextRs} />
                </div>
              )}

              {editShare && (
                <div className="preview-field">
                  <Text variant="body-sm-semibold">Share permissions</Text>
                  <ShareDiff
                    label="Users"
                    current={toSubjectPolicyMap(entry?.users)}
                    resulting={resultingShare(toSubjectPolicyMap(entry?.users), desiredUsers)}
                    mode={shareMode}
                  />
                  <ShareDiff
                    label="Teams"
                    current={toSubjectPolicyMap(entry?.teams)}
                    resulting={resultingShare(toSubjectPolicyMap(entry?.teams), desiredTeams)}
                    mode={shareMode}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Modal
        isOpen={confirmOpen}
        title={`Apply changes to ${datasets.length} dataset${datasets.length === 1 ? '' : 's'}?`}
        confirmButtonText={`Apply to ${datasets.length}`}
        cancelButtonText="Cancel"
        onConfirm={onConfirm}
        onClose={onConfirmClose}
      >
        <Text>
          This will write changes to {datasets.length} Search dataset
          {datasets.length === 1 ? '' : 's'}:
        </Text>
        <ul className="confirm-list">
          {editDatatypes && (
            <li>
              <Text>
                {datatypeMode === 'replace' ? 'Replace' : 'Append'} datatype rulesets
              </Text>
            </li>
          )}
          {editShare && (
            <li>
              <Text>
                {shareMode === 'replace' ? 'Replace' : 'Add'} share permissions (users and teams)
              </Text>
            </li>
          )}
        </ul>
        <Text color="attention">Existing configuration for these fields will be overwritten.</Text>
      </Modal>
    </div>
  );
}

function DiffRow({ before, after }: { before: string[]; after: string[] }) {
  return (
    <div className="diff-row">
      <div className="diff-side">
        <Text variant="body-sm-normal" color="subtle">
          Current
        </Text>
        <RulesetChips values={before} tone="current" />
      </div>
      <div className="diff-arrow" aria-hidden>
        →
      </div>
      <div className="diff-side">
        <Text variant="body-sm-normal" color="accent">
          New
        </Text>
        <RulesetChips values={after} tone="new" />
      </div>
    </div>
  );
}

/**
 * Ruleset list rendered as monospace chips. Current values read in muted tan and
 * new values in the amber accent, so the diff is legible without red/green coloring.
 */
function RulesetChips({ values, tone }: { values: string[]; tone: 'current' | 'new' }) {
  if (values.length === 0) return <span className="muted">—</span>;
  return (
    <div className="tag-row">
      {values.map((v, i) => (
        <span key={`${v}-${i}`} className={`diff-chip diff-chip-${tone}`}>
          {`${i + 1}. ${v}`}
        </span>
      ))}
    </div>
  );
}

function ShareDiff({
  label,
  current,
  resulting,
  mode,
}: {
  label: string;
  current: Map<string, Set<string>>;
  resulting: Map<string, Set<string>>;
  mode: ShareMode;
}) {
  const subjects = [...new Set([...current.keys(), ...resulting.keys()])].sort();
  if (subjects.length === 0) {
    return (
      <div className="share-diff">
        <Text variant="body-sm-normal" color="subtle">
          {label}: none
        </Text>
      </div>
    );
  }
  return (
    <div className="share-diff">
      <Text variant="body-sm-normal" color="subtle">
        {label}
      </Text>
      <table className="mini-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Current</th>
            <th>New</th>
          </tr>
        </thead>
        <tbody>
          {subjects.map((s) => {
            const cur = [...(current.get(s) ?? [])].sort();
            const res = [...(resulting.get(s) ?? [])].sort();
            const removed = mode === 'replace' && res.length === 0 && cur.length > 0;
            return (
              <tr key={s}>
                <td>
                  <Text variant="code">{s}</Text>
                </td>
                <td>{cur.length ? cur.join(', ') : <span className="muted">—</span>}</td>
                <td>
                  {removed ? (
                    <Text variant="body-sm-normal" color="subtle">
                      removed
                    </Text>
                  ) : res.length ? (
                    <Text variant="body-sm-normal" color="accent">
                      {res.join(', ')}
                    </Text>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
