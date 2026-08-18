import { Text } from '@capra/core';

interface ProgressBarProps {
  done: number;
  total: number;
  label?: string;
}

/** A simple token-styled determinate progress bar with a done/total caption. */
export function ProgressBar({ done, total, label }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress-head">
        <Text variant="body-sm-normal">{label ?? 'Progress'}</Text>
        <Text variant="body-sm-normal">
          {done} / {total}
        </Text>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
