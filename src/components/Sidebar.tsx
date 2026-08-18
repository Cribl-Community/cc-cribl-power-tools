import { useEffect, useState } from 'react';
import {
  AnglesLeft,
  AnglesRight,
  Bars,
  CloseOutlined,
  CustomSettings,
  Lake,
  Packs,
  Pipeline,
  SearchOutlined,
  Upload,
  type SvgIcon,
} from '@capra/icons';

/** The top-level sections of the app. Identical to App's view state machine. */
export type NavKey = 'search' | 'lake' | 'packs' | 'assign' | 'import';

interface NavItem {
  key: NavKey;
  name: string;
  Icon: SvgIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Navigation is grouped so related sections read together: dataset tools first,
 * then the worker-group configuration tools. Icons are drawn from @capra/icons
 * so the rail feels native to the platform.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Datasets',
    items: [
      { key: 'search', name: 'Search datasets', Icon: SearchOutlined },
      { key: 'lake', name: 'Lake datasets', Icon: Lake },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { key: 'assign', name: 'Pipeline assign', Icon: Pipeline },
      { key: 'import', name: 'Config import', Icon: Upload },
      { key: 'packs', name: 'Pack copy', Icon: Packs },
    ],
  },
];

interface ThemeOption {
  key: string;
  name: string;
}

interface SidebarProps {
  active: NavKey;
  onSelect: (key: NavKey) => void;
  theme: string;
  themes: ThemeOption[];
  onThemeChange: (key: string) => void;
}

const COLLAPSE_STORAGE_KEY = 'dm-sidebar-collapsed';

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    /* localStorage may be unavailable in the sandbox; default to expanded. */
    return false;
  }
}

function cx(...classes: (string | false | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * Persistent left navigation rail. Owns its own collapsed (desktop icon-rail)
 * and mobile-drawer state; the active section + theme are driven by App so the
 * existing view-switching state machine stays the single source of truth.
 *
 * The sidebar carries navigation + the theme control only — no data-scoping
 * selectors (worker group etc.) live here; those stay inside their views.
 */
export function Sidebar({ active, onSelect, theme, themes, onThemeChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
    } catch {
      /* ignore persistence failures */
    }
  }, [collapsed]);

  const currentThemeName = themes.find((t) => t.key === theme)?.name ?? theme;

  const handleSelect = (key: NavKey) => {
    onSelect(key);
    setMobileOpen(false);
  };

  const cycleTheme = () => {
    if (themes.length === 0) return;
    const idx = themes.findIndex((t) => t.key === theme);
    const next = themes[(idx + 1) % themes.length];
    onThemeChange(next.key);
  };

  return (
    <>
      {/* Narrow-viewport top bar: hamburger opens the off-canvas drawer. */}
      <div className="mobile-topbar">
        <button
          type="button"
          className="icon-btn"
          aria-label="Open navigation"
          aria-expanded={mobileOpen}
          aria-controls="app-sidebar"
          onClick={() => setMobileOpen(true)}
        >
          <Bars />
        </button>
        <span className="sidebar-brand-title">CC Cribl Power Tools</span>
      </div>

      {mobileOpen ? (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={cx(
          'sidebar',
          collapsed && 'sidebar-collapsed',
          mobileOpen && 'sidebar-mobile-open',
        )}
        aria-label="Primary navigation"
      >
        <div className="sidebar-brand">
          <span className="sidebar-brand-mark" aria-hidden="true">
            <Pipeline />
          </span>
          {!collapsed ? <span className="sidebar-brand-title">CC Cribl Power Tools</span> : null}
          <button
            type="button"
            className="icon-btn sidebar-mobile-close"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
          >
            <CloseOutlined />
          </button>
        </div>

        <nav className="sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <div className="sidebar-group" key={group.label}>
              {collapsed ? (
                <div className="sidebar-group-sep" aria-hidden="true" />
              ) : (
                <div className="sidebar-group-label">{group.label}</div>
              )}
              {group.items.map((item) => {
                const isActive = active === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={cx('sidebar-item', isActive && 'sidebar-item-active')}
                    aria-current={isActive ? 'page' : undefined}
                    title={collapsed ? item.name : undefined}
                    onClick={() => handleSelect(item.key)}
                  >
                    <span className="sidebar-item-icon" aria-hidden="true">
                      <item.Icon />
                    </span>
                    {!collapsed ? <span className="sidebar-item-label">{item.name}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          {collapsed ? (
            <button
              type="button"
              className="sidebar-item sidebar-theme-cycle"
              aria-label={`Theme: ${currentThemeName}. Activate to change theme.`}
              title={`Theme: ${currentThemeName}`}
              onClick={cycleTheme}
            >
              <span className="sidebar-item-icon" aria-hidden="true">
                <CustomSettings />
              </span>
            </button>
          ) : (
            <label className="sidebar-theme">
              <span className="sidebar-theme-label">Theme</span>
              <select
                className="native-select"
                aria-label="UI theme"
                value={theme}
                onChange={(e) => onThemeChange(e.target.value)}
              >
                {themes.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            className="icon-btn sidebar-collapse-btn"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
            onClick={() => setCollapsed((c) => !c)}
          >
            {collapsed ? <AnglesRight /> : <AnglesLeft />}
            {!collapsed ? <span>Collapse</span> : null}
          </button>
        </div>
      </aside>
    </>
  );
}
