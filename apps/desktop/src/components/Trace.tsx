import { cn, signalText, type Signal } from '@agenterm/ui';
import * as React from 'react';

/** Bytes per second that reads as a full-height spike. Log-scaled below. */
const FULL_SCALE = 16 * 1024;

/**
 * Heartbeat of one agent: terminal output volume per second, newest at
 * the right. Log scale so a single prompt line is visible next to a
 * build log. A flat line means the agent produced nothing.
 */
export const Trace = React.memo(function Trace({
  samples,
  signal,
  className,
  height = 18
}: {
  samples: number[];
  signal: Signal;
  className?: string;
  height?: number;
}): React.JSX.Element {
  const n = samples.length;
  const top = Math.log1p(Math.max(FULL_SCALE, ...samples));
  const pad = 1.5;
  const y = (value: number): number => height - pad - (Math.log1p(value) / top) * (height - pad * 2);
  const points = samples.map((value, i) => `${i},${y(value).toFixed(2)}`).join(' ');
  const flat = samples.every((value) => value === 0);
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, n - 1)} ${height}`}
      preserveAspectRatio="none"
      className={cn('block w-full', signalText[signal], className)}
      style={{ height }}
      aria-hidden
    >
      {flat ? null : <polygon points={`0,${height} ${points} ${n - 1},${height}`} fill="currentColor" opacity={0.14} />}
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        opacity={flat ? 0.35 : 1}
      />
    </svg>
  );
});
