import { Switch, Text } from '@capra/core';

interface LabeledSwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Optional helper text shown under the label. */
  hint?: string;
}

/**
 * Capra's <Switch> renders a bare <input role="switch"> and ignores children, so
 * the visible label is provided here via a wrapping <label> (which also makes the
 * text a click target for the control).
 */
export function LabeledSwitch({ label, checked, onChange, hint }: LabeledSwitchProps) {
  return (
    <label className="switch-row">
      <Switch aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-text">
        <Text variant="body-sm-semibold">{label}</Text>
        {hint && (
          <Text variant="body-sm-normal" color="subtle">
            {hint}
          </Text>
        )}
      </span>
    </label>
  );
}
