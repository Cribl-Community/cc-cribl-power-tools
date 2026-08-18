import { useEffect, useState } from 'react';
import { Sidebar, type NavKey } from './components/Sidebar';
import { DashboardHeader } from './components/DashboardHeader';
import { SearchBulkEdit } from './workflows/SearchBulkEdit';
import { LakeBulkCreate } from './workflows/LakeBulkCreate';
import { PackCopy } from './workflows/PackCopy';
import { PipelineAssign } from './workflows/PipelineAssign';
import { ConfigImport } from './workflows/ConfigImport';

type ThemeKey = 'capra' | 'terminal' | 'mario' | 'doom';

const THEMES: { key: ThemeKey; name: string }[] = [
  { key: 'capra', name: 'Default' },
  { key: 'terminal', name: 'Aged terminal' },
  { key: 'mario', name: 'Super Jump' },
  { key: 'doom', name: 'Space Marine' },
];

/** Per-dashboard heading + usage blurb, shown above each workflow. */
const DASHBOARDS: Record<NavKey, { title: string; description: string }> = {
  search: {
    title: 'Search datasets — bulk edit',
    description:
      'Edit many Cribl Search datasets in one pass — update their datatype (event breaker) rulesets and/or share permissions across every selected dataset. Filter and select datasets in the table, turn on the edits you want, then preview the exact before/after diff before applying. Enable Dry run to validate the changes without writing anything.',
  },
  lake: {
    title: 'Lake datasets — bulk create',
    description:
      'Create many Cribl Lake datasets at once, optionally with matching Stream Destinations. Pick a Lake storage location and dataset settings, enter one dataset name per line, and create them in a single batch. To also wire up delivery, target a worker group to create paired cribl_lake Destinations, then commit (and optionally deploy) the group.',
  },
  packs: {
    title: 'Pack copy — across workspaces',
    description:
      'Copy packs from a worker group in this workspace into worker groups in other Cribl workspaces. Choose the source worker group and the packs to copy, add the destination workspace and its API credentials, then run the copy. Destination workspaces must be declared at build time; commit (and optionally deploy) the target group when finished.',
  },
  assign: {
    title: 'Pipelines — bulk assign',
    description:
      'Assign or clear the pre-/post-processing pipeline on many Sources or Destinations in a worker group at once. Pick a worker group, switch between Sources and Destinations, select the items to change, choose a pipeline (or clear the assignment), and preview before applying. Changes are committed (and optionally deployed) to the group.',
  },
  import: {
    title: 'Configs — bulk import',
    description:
      'Import Pipelines, Sources, or Destinations into a worker group from JSON files. Choose the config type and target worker group, drag-and-drop or browse to your JSON files, and review the validation results. Only valid, non-conflicting configs are imported — existing configs are never overwritten. Commit (and optionally deploy) the group when done.',
  },
};

const THEME_STORAGE_KEY = 'dm-theme';

function loadTheme(): ThemeKey {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (
      saved === 'capra' ||
      saved === 'terminal' ||
      saved === 'mario' ||
      saved === 'doom'
    )
      return saved;
  } catch {
    /* localStorage may be unavailable in the sandbox; fall back to default. */
  }
  return 'capra';
}

function App() {
  const [tab, setTab] = useState<NavKey>('search');
  const [theme, setTheme] = useState<ThemeKey>(loadTheme);

  // Apply the selected theme as a class on <html> so both the --dm-* palette and
  // the Capra --cds2-* remaps switch together, and persist the choice.
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-capra', 'theme-terminal', 'theme-mario', 'theme-doom');
    root.classList.add(`theme-${theme}`);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore persistence failures */
    }
  }, [theme]);

  return (
    <div className="app">
      <Sidebar
        active={tab}
        onSelect={setTab}
        theme={theme}
        themes={THEMES}
        onThemeChange={(k) => setTheme(k as ThemeKey)}
      />

      <div className="app-body">
        <main className="app-main">
          <DashboardHeader title={DASHBOARDS[tab].title} description={DASHBOARDS[tab].description} />
          {tab === 'search' ? (
            <SearchBulkEdit />
          ) : tab === 'lake' ? (
            <LakeBulkCreate />
          ) : tab === 'packs' ? (
            <PackCopy />
          ) : tab === 'assign' ? (
            <PipelineAssign />
          ) : (
            <ConfigImport />
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
