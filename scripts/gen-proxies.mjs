// Generate exact per-workspace Leader FQDN entries in config/proxies.yml.
//
// WHY: Cribl's app-platform proxy matches proxies.yml domain keys EXACTLY. Wildcard /
// subdomain keys (`*.cribl.cloud`, `.cribl.cloud`) are NOT honored, so every destination
// workspace the Pack Copy workflow (Workflow 3) can reach must be declared as its own
// entry. Workspace Leader FQDNs are dynamic per organization, so this script discovers
// them from the management plane and writes one entry per workspace into the managed
// block of config/proxies.yml (between the BEGIN/END markers). The fixed login/gateway
// entries above the block are left untouched.
//
// USAGE (from the project root):
//   CRIBL_CLIENT_ID=... CRIBL_CLIENT_SECRET=... npm run proxies:gen -- --org <organizationId>
// or pass everything as flags:
//   npm run proxies:gen -- --org <organizationId> --client-id <id> --client-secret <secret>
//
// Use the same Organization API Credential (Client ID + Secret) the app uses. Re-run this
// whenever workspaces are added or removed, then `npm run package` and reinstall the app.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const LOGIN_URL = 'https://login.cribl.cloud/oauth/token';
const TOKEN_AUDIENCE = 'https://api.cribl.cloud';
const GATEWAY_BASE = 'https://gateway.cribl.cloud';

// Markers delimiting the region this script owns. Everything between them is regenerated;
// everything outside (login.cribl.cloud, gateway.cribl.cloud, comments) is preserved.
const BEGIN = '# >>> BEGIN generated workspace leaders (managed by `npm run proxies:gen`) >>>';
const END = '# <<< END generated workspace leaders <<<';

const proxiesPath = join(import.meta.dirname, '..', 'config', 'proxies.yml');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    org: { type: 'string' },
    'client-id': { type: 'string' },
    'client-secret': { type: 'string' },
  },
});

const orgId = values.org || process.env.CRIBL_ORG_ID;
const clientId = values['client-id'] || process.env.CRIBL_CLIENT_ID;
const clientSecret = values['client-secret'] || process.env.CRIBL_CLIENT_SECRET;

if (!orgId) fail('Missing organization id. Pass --org <id> or set CRIBL_ORG_ID.');
if (!clientId) fail('Missing client id. Pass --client-id <id> or set CRIBL_CLIENT_ID.');
if (!clientSecret) fail('Missing client secret. Pass --client-secret <secret> or set CRIBL_CLIENT_SECRET.');

async function getToken() {
  let res;
  try {
    res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        audience: TOKEN_AUDIENCE,
      }),
    });
  } catch (err) {
    fail(`Could not reach ${LOGIN_URL}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    fail(`Token request failed (${res.status}). Check the Client ID/Secret. ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
  const data = await res.json();
  if (!data.access_token) fail('Token endpoint returned no access_token.');
  return data.access_token;
}

async function listWorkspaces(token) {
  const url = `${GATEWAY_BASE}/v1/organizations/${encodeURIComponent(orgId)}/workspaces`;
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  } catch (err) {
    fail(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    fail(`Listing workspaces failed (${res.status}). Check the organization id. ${(await res.text().catch(() => '')).slice(0, 300)}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** One proxies.yml entry for a workspace Leader FQDN. */
function block(fqdn) {
  return [
    `${fqdn}:`,
    '  paths:',
    '    allowlist:',
    '      - /api/v1/',
    '  headers:',
    '    inject:',
    `      Authorization: "'Bearer ' + kv.packCopyToken"`,
    '    allowlist:',
    '      - content-type',
    '      - accept',
  ].join('\n');
}

const token = await getToken();
const workspaces = await listWorkspaces(token);
const active = workspaces.filter((w) => !w.state || w.state === 'Active');
const fqdns = [...new Set(active.map((w) => w.leaderFQDN).filter(Boolean))].sort();

if (fqdns.length === 0) {
  fail('No Active workspaces with a leaderFQDN were returned for this organization.');
}

const generated = [
  BEGIN,
  '# Do not edit by hand — run `npm run proxies:gen` to refresh, then `npm run package`.',
  `# ${fqdns.length} workspace(s) discovered for organization ${orgId}.`,
  ...fqdns.map(block),
  END,
].join('\n');

const current = await readFile(proxiesPath, 'utf8');
let next;
if (current.includes(BEGIN) && current.includes(END)) {
  const before = current.slice(0, current.indexOf(BEGIN));
  const after = current.slice(current.indexOf(END) + END.length);
  next = `${before}${generated}${after}`;
} else {
  // No managed block yet — append one at the end of the file.
  next = `${current.replace(/\s*$/, '')}\n\n${generated}\n`;
}
await writeFile(proxiesPath, next.endsWith('\n') ? next : `${next}\n`);

console.log(`\n✔ Wrote ${fqdns.length} workspace entr${fqdns.length === 1 ? 'y' : 'ies'} to config/proxies.yml:`);
for (const f of fqdns) console.log(`   - ${f}`);
console.log('\nNext:  npm run package   →   reinstall the .tgz in your workspace.\n');
