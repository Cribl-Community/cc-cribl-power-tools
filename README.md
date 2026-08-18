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

> **Required one-time setup before this workflow works:** each destination workspace
> must be added to the app at build time. The platform only lets the app reach
> workspaces that are listed in its configuration, and it does **not** support
> shortcuts that match "any workspace" — so you list them explicitly, using the helper
> script provided. Full click-by-click instructions are in
> **["Declaring destination workspaces (required setup)"](#declaring-destination-workspaces-required-setup)**
> below. If a workspace's worker groups don't load and you see a "not declared in
> proxies.yml" message, that setup hasn't been done for that workspace yet.

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

## Declaring destination workspaces (required setup)

**Read this if you want to use the "Pack copy — across workspaces" workflow.**

For safety, the Cribl platform only lets this app talk to workspaces that are
written into the app *before it is built*. There is no "allow any workspace"
option. So, once (and again whenever your list of workspaces changes), someone with
access to the app's source folder runs a small helper that fills in the list of
workspaces for you, rebuilds the app, and reinstalls it. This is a one-time-ish
technical setup — the people who *use* the workflow day-to-day don't need to do it.

You do **not** need to be a developer to follow these steps. Do them on a normal
laptop, in order.

### What you'll need before you start

1. **The app's source folder** on your computer (the folder that contains this
   `README.md` and a `package.json` file).
2. **Node.js** installed (this provides the `npm` command used below). If you don't
   have it, download the "LTS" installer from <https://nodejs.org> and run it, then
   restart your terminal. To check it's installed, run `node --version` — you should
   see a version number.
3. **An Organization API Credential** from Cribl.Cloud — a **Client ID** and a
   **Client Secret** (see Step 4). Use the *same* credential the app itself uses.
4. **Your Organization ID** (see Step 5).

### Step 1 — Open a terminal

- **macOS:** open the **Terminal** app (press `Cmd`+`Space`, type "Terminal",
  press Enter).
- **Windows:** open **Command Prompt** or **PowerShell** (click Start, type
  "PowerShell", press Enter).

A terminal is just a window where you type commands and press Enter to run them.

### Step 2 — Go to the app's folder

In the terminal, type `cd ` (the letters c, d, and a space), then drag the app's
folder from your file browser onto the terminal window (this pastes its location),
then press Enter. For example:

```bash
cd /path/to/cc-cribl-power-tools
```

You're now "inside" the folder. To confirm, run `ls` (macOS) or `dir` (Windows) and
check you see `package.json` in the list.

### Step 3 — Install the app's building blocks (first time only)

Run this once. It downloads the pieces the app needs to build. It can take a couple
of minutes and prints a lot of text — that's normal.

```bash
npm install
```

### Step 4 — Create an Organization API Credential in Cribl.Cloud

1. Sign in to Cribl.Cloud as an organization admin.
2. Go to **Organization → API Credentials** (top-level org settings, not inside a
   single workspace).
3. Create a new credential with **Owner** privileges (required — copying packs into other
   workspaces needs org-Owner access; a lesser role will fail). Give it a name you'll
   recognize (e.g. `pack-copy-setup`).
4. Copy the **Client ID** and the **Client Secret** somewhere safe. The secret is
   usually shown only once.

> Treat the secret like a password. When you're finished with all your pack copying,
> disable or delete this credential in the same screen.

### Step 5 — Find your Organization ID

Your Organization ID is the short code in your Cribl.Cloud web address. When you're
logged in, the browser URL looks like `https://<something>-<organizationId>.cribl.cloud`
— the Organization ID is the part right before `.cribl.cloud`. It's also shown under
**Organization → Settings**. Example: `modest-emmy-r9clsle`.

### Step 6 — Run the generator

Now run the helper. Replace the three placeholders with your real values (keep the
quotes if your values contain special characters):

**macOS / Linux:**

```bash
CRIBL_CLIENT_ID="your-client-id" CRIBL_CLIENT_SECRET="your-client-secret" \
  npm run proxies:gen -- --org your-organization-id
```

**Windows (PowerShell):**

```powershell
$env:CRIBL_CLIENT_ID="your-client-id"; $env:CRIBL_CLIENT_SECRET="your-client-secret"; npm run proxies:gen -- --org your-organization-id
```

If you'd rather not use the environment-variable style above, you can pass all three
values directly (this works the same on every system):

```bash
npm run proxies:gen -- --org your-organization-id --client-id your-client-id --client-secret your-client-secret
```

### Step 7 — Check it worked

If it succeeded, the command prints something like:

```
✔ Wrote 4 workspace entries to config/proxies.yml:
   - workspace-a-modest-emmy-r9clsle.cribl.cloud
   - workspace-b-modest-emmy-r9clsle.cribl.cloud
   ...
Next:  npm run package   →   reinstall the .tgz in your workspace.
```

If instead you see a message starting with `✖`, read it — it usually means the
Organization ID, Client ID, or Client Secret was mistyped. Fix it and run Step 6
again. Nothing is changed until the command succeeds.

### Step 8 — Build the installable app package

```bash
npm run package
```

This rebuilds the app with the new workspace list and creates an installable file in
the `build/` folder named like `cc-cribl-power-tools-1.2.3.tgz` (the version number
increases each time). The command prints the exact file path on the last line.

### Step 9 — Install the app into Cribl

1. In Cribl.Cloud, go to the **Apps** area for your workspace.
2. Choose to **install / upgrade an app** and upload the `.tgz` file from the
   `build/` folder (the one from Step 8).
3. Make sure the app is shared with the people who should use it.
4. Reload the app in your browser.

The destination workspaces you generated will now load in the "Pack copy" workflow.

### When to run this again

Repeat **Steps 6, 8, and 9** whenever workspaces are **added or removed** in your
organization (new workspaces won't appear as copy destinations until you do). You do
not need to repeat Steps 1–5 each time.

### Advanced: editing the list by hand

The workspace list lives in `config/proxies.yml`, between the lines marked
`# >>> BEGIN generated workspace leaders …` and `# <<< END generated workspace leaders …`.
To add one workspace manually, copy an existing entry and change only the hostname (the
first line, ending in `.cribl.cloud`). The generator overwrites everything between those
two marker lines, so hand edits there are replaced the next time you run it.

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
  listing/uploading/installing packs and committing/deploying the group. These are
  generated into `proxies.yml` at build time — see "Declaring destination workspaces"
  above — because the proxy matches domain keys exactly and does not support wildcards.

The org Bearer token is injected on the gateway and workspace hosts from the
app-scoped KV store (key `packCopyToken`), because the platform strips any
`Authorization` header the app sets itself. The KV store paths are granted
automatically and are not declared in `policies.yml`.

If a declared collection path is missing its wildcard/detail counterpart, list
results can come back empty — keep `config/policies.yml` in sync when adding new
calls.
