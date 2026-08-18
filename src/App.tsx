import { useEffect, useState } from 'react';
import { TabNav, Text } from '@capra/core';
import { SearchBulkEdit } from './workflows/SearchBulkEdit';
import { LakeBulkCreate } from './workflows/LakeBulkCreate';
import { PackCopy } from './workflows/PackCopy';

type TabKey = 'search' | 'lake' | 'packs';

const TABS = [
  { key: 'search', name: 'Search datasets — bulk edit' },
  { key: 'lake', name: 'Lake datasets — bulk create' },
  { key: 'packs', name: 'Pack copy — across workspaces' },
];

type ThemeKey = 'capra' | 'terminal' | 'mario' | 'doom';

const THEMES: { key: ThemeKey; name: string }[] = [
  { key: 'capra', name: 'Capra (design system)' },
  { key: 'terminal', name: 'Aged terminal' },
  { key: 'mario', name: 'Super Mario' },
  { key: 'doom', name: 'DOOM' },
];

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
  const [tab, setTab] = useState<TabKey>('search');
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
      <header className="app-header">
        <div className="app-header-titles">
          <Text as="h1" variant="heading-md">
            CC Cribl Power Tools
          </Text>
          <Text variant="body-sm-normal" color="subtle">
            Bulk-edit Search datasets, bulk-create Lake datasets, and copy packs across
            workspaces.
          </Text>
        </div>
        <label className="theme-select">
          <Text variant="body-sm-normal" color="subtle">
            Theme
          </Text>
          <select
            className="native-select"
            aria-label="UI theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeKey)}
          >
            {THEMES.map((t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="app-tabs">
        <TabNav
          activeKey={tab}
          items={TABS.map((t) => ({ key: t.key, name: t.name, href: `#${t.key}` }))}
          onTabClick={(key, event) => {
            event.preventDefault();
            setTab(key as TabKey);
          }}
        />
      </div>

      <main className="app-main">
        {tab === 'search' ? (
          <SearchBulkEdit />
        ) : tab === 'lake' ? (
          <LakeBulkCreate />
        ) : (
          <PackCopy />
        )}
      </main>
    </div>
  );
}

export default App;
