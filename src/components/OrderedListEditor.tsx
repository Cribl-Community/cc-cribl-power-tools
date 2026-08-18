import { useState } from 'react';
import { Button, TextField, Text } from '@capra/core';

export interface Option {
  value: string;
  label: string;
}

interface OrderedListEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Optional known values, offered as a native datalist for autocomplete. */
  suggestions?: string[];
  /**
   * When provided, adding is done by picking from this list (a dropdown of the
   * still-unselected options) instead of free-text entry.
   */
  options?: Option[];
  /** Shown when `options` is set but every option is already selected. */
  emptyOptionsLabel?: string;
  addLabel?: string;
}

/** Editor for an ordered, de-duplicated list of string identifiers (e.g. rulesets). */
export function OrderedListEditor({
  value,
  onChange,
  placeholder,
  suggestions,
  options,
  emptyOptionsLabel = 'No more options available',
  addLabel = 'Add',
}: OrderedListEditorProps) {
  const [draft, setDraft] = useState('');
  const listId = `ole-${Math.abs(hash(placeholder ?? addLabel))}`;

  const add = (raw?: string) => {
    const v = (raw ?? draft).trim();
    if (!v || value.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...value, v]);
    setDraft('');
  };

  const remaining = options?.filter((o) => !value.includes(o.value)) ?? [];

  const remove = (i: number) => onChange(value.filter((_, idx) => idx !== i));

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="ole">
      <div className="ole-add">
        {options ? (
          <select
            className="native-select"
            aria-label={placeholder ?? 'Add entry'}
            value=""
            disabled={remaining.length === 0}
            onChange={(e) => {
              if (e.target.value) add(e.target.value);
            }}
          >
            <option value="" disabled>
              {remaining.length === 0 ? emptyOptionsLabel : (placeholder ?? 'Select…')}
            </option>
            {remaining.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <TextField
              aria-label={placeholder ?? 'New entry'}
              placeholder={placeholder}
              value={draft}
              onChange={setDraft}
              list={suggestions && suggestions.length > 0 ? listId : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <Button onClick={() => add()} disabled={!draft.trim()}>
              {addLabel}
            </Button>
            {suggestions && suggestions.length > 0 && (
              <datalist id={listId}>
                {suggestions.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            )}
          </>
        )}
      </div>

      {value.length === 0 ? (
        <Text variant="body-sm-normal" color="subtle">
          No entries.
        </Text>
      ) : (
        <ol className="ole-list">
          {value.map((item, i) => (
            <li key={item} className="ole-item">
              <Text variant="body-sm-normal" color="subtle">
                {i + 1}.
              </Text>
              <Text variant="code">{item}</Text>
              <div className="ole-item-actions">
                <Button size="sm" onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </Button>
                <Button size="sm" onClick={() => move(i, 1)} disabled={i === value.length - 1}>
                  ↓
                </Button>
                <Button size="sm" appearance="danger" onClick={() => remove(i)}>
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return h;
}
