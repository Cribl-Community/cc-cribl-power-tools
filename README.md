# CC Cribl Power Tools

A Cribl App for bulk operations on datasets, packaged for install into a Cribl
workspace. It provides three workflows:

- **Search datasets — bulk edit:** update datatype (Event Breaker) rulesets and
  share permissions across many Search datasets at once.
- **Lake datasets — bulk create:** create multiple Cribl Lake datasets from a
  single shared-settings form and a list of names.
- **Pack copy — across workspaces:** copy one or more packs from a worker group in
  this workspace to a worker group in a *different* workspace of the same
  Cribl.Cloud organization, skipping any that already exist.

Every write is gated behind a preview and an explicit confirmation, a global
**Dry run** toggle lets you validate without writing, and a single failure never
aborts the rest of a batch — you get a per-item succeeded/failed summary with the
API error message for each failure.

Authentication is handled entirely by the Cribl platform (the fetch proxy injects
credentials). The app manages no tokens or auth settings of its own.

---

## Installation

1. Log in to Cribl and then click on **Apps->View All**
2. Click **Add App->Import from Git**.
3. Paste the repo url and "latest" for the release tag.
4. Click **Import**.

---

## Usage

### Switching themes

A theme selector sits in the top-right of the header:

- **Aged terminal** — the default dark, warm-sepia look.
- **Super Mario** — a bright, game-styled alternative.

Your choice is remembered across sessions (stored in `localStorage`).

### Workflow 1 — Search datasets: bulk edit

1. The datasets table loads automatically; share permissions load per row in the
   background.
2. **Filter** by id, description, or provider, and/or by a specific provider.
   Click a column header to **sort**.
3. **Select** datasets with the row checkboxes, or use *Select filtered* /
   *Select all* / *Clear*.
4. Under **Bulk edits**, enable either or both edits:
   - **Update datatype rulesets** — choose *Replace existing* or *Append to
     existing*, then add rulesets from the picker (populated from the available
     Event Breaker rulesets). Reorder or remove entries as needed.
   - **Update share permissions** — choose *Add / merge grants* or *Replace all
     grants*, then add grants. Each grant is a subject (pick a **User** or
     **Team** from the list) plus a permission policy.
5. Click **Preview changes** to see a per-dataset diff (current values vs. the
   new values). Nothing is written yet.
6. Click **Apply** (or **Run dry run** if Dry run is on) and confirm. Progress is
   shown per dataset, followed by a succeeded/failed summary.

### Workflow 2 — Lake datasets: bulk create

1. Fill in the **shared settings** applied to every new dataset: storage
   location, retention (days), and data format.
2. Enter one dataset per line in the names box. Each line is either `name` or
   `name, description`.
3. Optionally enable **Also create Lake Destinations**. When on, pick a Stream
   **worker group**; the app then creates a matching `cribl_lake` Destination
   (same id as the dataset, pointing at that dataset) alongside each dataset, and
   commits + deploys the group once the batch finishes.
4. Validation runs inline — naming-rule violations, duplicates within your input,
   collisions with existing dataset names, and (when the destination option is on)
   collisions with existing destination names in the selected group are flagged so
   you can fix them before continuing.
5. **Preview** the valid rows, then **Create** (or **Run dry run**) and confirm.
   You get the same per-row progress and succeeded/failed summary. With the
   destination option on, each row reports both objects: the dataset is created
   first, then its destination; if the dataset fails, its destination is skipped,
   and if only the destination fails the dataset is still reported as succeeded.

### Workflow 3 — Pack copy across workspaces

This workflow copies packs between workspaces of the same Cribl.Cloud
organization. Because that reaches the Cribl.Cloud **management plane** and other
workspaces' Leaders (outside the current-workspace API the platform
auto-authenticates), it needs an **Organization API Credential**:

1. In Cribl.Cloud, create a dedicated, least-privilege credential under
   **Organization → API Credentials** and copy its Client ID and Secret.
2. On first use, the app prompts for the **Organization ID, Client ID, and
   Secret**. These are stored **encrypted in the app's KV store** and exchanged for
   a short-lived OAuth token; the token is injected as a Bearer on management-plane
   requests. The app never sets the auth header directly (the platform proxy strips
   it) — it relies on `config/proxies.yml` injection.
3. Pick, in order: a **source worker group** (this workspace) → the **packs** to
   copy → a **destination workspace** (others in the org; the current one is
   excluded) → a **destination worker group**. Changing an earlier choice clears the
   later ones.
4. Packs already present in the destination (matched by pack id) are flagged and
   **skipped — never overwritten**; the preview shows existing vs. source version.
   If *every* selected pack conflicts, submission is blocked.
5. **Preview**, then **Copy** (or **Run dry run**) and confirm. Each pack is copied
   one at a time (export from source → upload → install into the destination); a
   single failure never aborts the rest. Afterwards the destination group is
   committed (and deployed, if you chose that) once, and the per-pack
   copied/skipped/failed summary is shown.

> **Security:** the API Credential must have **Owner** privileges — installing and
> deploying packs in other workspaces requires org-Owner access, so a least-privilege
> credential will not work. It therefore grants full org-wide API access and lives in an
> app-scoped (shared) KV store, so use a dedicated credential. When you're done, choose
> **"No, I'm done — remove credentials"** on the results page to delete it from the app's
> storage, and disable or delete it in Cribl.Cloud too.

> **One-time setup before this workflow works:** each destination workspace must be
> enabled for the app. The platform only lets the app reach workspace hosts that are
> listed in its **External API Access** config, and it does **not** support shortcuts
> that match "any workspace" — so you list each destination workspace's Leader host
> explicitly. An app admin can do this in the app's own settings, **without repackaging
> or reinstalling** — full instructions are in
> **["Enabling destination workspaces"](#enabling-destination-workspaces)** below. If a
> workspace's worker groups don't load and you see a "not declared in proxies.yml"
> message, that host hasn't been added yet.

### Dry run

All three workflows have a **Dry run** switch. When enabled, the app runs the full
preview/confirm/progress flow but makes **no write calls** — use it to validate a
batch before committing. (For Pack copy, dry run still performs all reads and
conflict checks, but exports/uploads/installs nothing.)

---

## Development

Requires Node and npm.

```bash
npm install      # install dependencies
npm run dev      # start the Vite dev server (http://localhost:5173)
npm run build    # type-check (tsc -b) and build
npm run lint     # oxlint
npm run preview  # preview the production build
```

The app reads the Cribl API base from `window.CRIBL_API_URL`, which is only
present when running inside a Cribl workspace. In local dev that global is
absent, so the workflows show a "must run inside Cribl" notice instead of live
data. To exercise it against real data, load the dev server inside a Cribl
workspace.

## Packaging & install

```bash
npm run package               # build + create build/<name>-<version>.tgz
npm run package -- --minor    # bump the minor version instead of patch
npm run package -- --major    # bump the major version
npm run package -- --version 2.1.0   # set an explicit version
```

`npm run package` bumps the version in `package.json`, rebuilds, and writes an
installable `.tgz` to `build/`. Install that artifact into a Cribl workspace as
an admin, then share the app with the users who should have access.

## Enabling destination workspaces

**Read this if you want to use the "Pack copy — across workspaces" workflow.**

For safety, the Cribl platform only lets this app reach workspaces whose hosts are
listed in the app's **External API Access** configuration. There is no "allow any
workspace" option — hosts are matched exactly — so each destination workspace is listed
by its **Leader host** (a name like `<workspace>-<organizationId>.cribl.cloud`).

An app admin can add these hosts **in place, without repackaging or reinstalling the
app.** You don't need the source folder, Node, or a terminal — just admin access to the
app's settings in Cribl. This is a one-time-ish step; the people who *use* the workflow
day-to-day don't need to do it.

### Steps

1. In Cribl, open the installed app and go to **App Settings → External API Access**.
2. The config ships with a **placeholder entry** for you to edit:

   ```yaml
   REPLACE-WITH-YOUR-WORKSPACE-LEADER.cribl.cloud:
     paths:
       allowlist:
         - /api/v1/
     headers:
       inject:
         Authorization: "'Bearer ' + kv.packCopyToken"
       allowlist:
         - content-type
         - accept
   ```

   Replace **only the hostname** (the first line) with your destination workspace's
   **Leader host** — a name like `main-<workspace>-<organizationId>.cribl.cloud`. Leave
   everything under it as-is (the `Authorization` injection is required: the platform
   strips any auth header the app sets itself, so the org Bearer token is injected here
   from the app's KV store, key `packCopyToken`, which the app writes when you save your
   API credential).
3. If you don't know the exact host, the Pack Copy workflow shows it to you: pick the
   workspace as a destination and, when it can't be reached, the error names the exact
   Leader host to use. To enable **more** workspaces, copy the whole block and change
   only the hostname on each copy.
4. Save the External API Access config, then reload the app. The destination workspace's
   worker groups will now load in the "Pack copy" workflow.

### When to do this again

Add a new entry whenever you want to copy packs to a workspace you haven't enabled yet
(for example, a newly created workspace). Existing entries keep working — you only add
hosts you haven't listed before.

## API access & permissions

The Cribl API paths the app needs are declared in `config/policies.yml`; admins
see exactly which resources it uses at install time. It calls:

- Search datasets (list, get, update rulesets, read/apply user & team ACLs) in
  the `default_search` group context.
- Event Breaker rulesets (to populate the datatype-ruleset picker).
- Users and teams (to populate the share-permission subject pickers). On Cribl
  Cloud the user list comes from the Search product Members endpoint
  (`/products/search/users`); `/system/users` is the on-prem fallback.
- Cribl Lake datasets and storage locations (list and create).
- Stream worker groups (`/master/groups`), group Destinations
  (`/m/:gid/system/outputs`), and Git commit + deploy (`/m/:gid/version/commit`,
  `/master/groups/:id/deploy`) — used only by the optional paired Lake Destination
  creation in Workflow 2.
- Source packs (`/m/:gid/packs`, `/m/:gid/packs/:id/export`) in the current
  workspace — the source side of Workflow 3.

Workflow 3 also reaches **external** Cribl.Cloud hosts, declared in
`config/proxies.yml` (admins see these at install time):

- `login.cribl.cloud` — OAuth token exchange (client-credentials grant).
- `gateway.cribl.cloud` — management plane; lists the organization's workspaces.
- One entry **per destination workspace Leader** (`<leaderFQDN>/api/v1`) for
  listing/uploading/installing packs and committing/deploying the group. `login` and
  `gateway` ship with the app; the per-workspace Leader hosts are added by an app admin
  in **App Settings → External API Access** — see "Enabling destination workspaces"
  above — because the proxy matches hosts exactly and does not support wildcards.

The org Bearer token is injected on the gateway and workspace hosts from the
app-scoped KV store (key `packCopyToken`), because the platform strips any
`Authorization` header the app sets itself. The KV store paths are granted
automatically and are not declared in `policies.yml`.

If a declared collection path is missing its wildcard/detail counterpart, list
results can come back empty — keep `config/policies.yml` in sync when adding new
calls.
