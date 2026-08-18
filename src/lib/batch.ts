// Sequential batch runner. Applies an async operation to each item one at a time,
// reporting progress after every item. A failure on one item is captured and never
// aborts the remaining work.

export interface BatchItemResult<T> {
  item: T;
  ok: boolean;
  /** Error message when ok === false. */
  error?: string;
  /** True when the operation was skipped because of dry-run mode. */
  dryRun?: boolean;
}

export interface BatchProgress<T> {
  done: number;
  total: number;
  current: T;
  results: BatchItemResult<T>[];
}

export interface RunBatchOptions {
  /** When true, the operation is not invoked; every item is recorded as a dry run. */
  dryRun?: boolean;
  signal?: AbortSignal;
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Run `op` for each item sequentially. Returns one result per item, in order.
 * `onProgress` fires after each item completes (success or failure).
 */
export async function runBatch<T>(
  items: T[],
  op: (item: T) => Promise<void>,
  onProgress: (progress: BatchProgress<T>) => void,
  options: RunBatchOptions = {},
): Promise<BatchItemResult<T>[]> {
  const { dryRun = false, signal } = options;
  const results: BatchItemResult<T>[] = [];

  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) break;
    const item = items[i];
    if (dryRun) {
      results.push({ item, ok: true, dryRun: true });
    } else {
      try {
        await op(item);
        results.push({ item, ok: true });
      } catch (err) {
        results.push({ item, ok: false, error: toMessage(err) });
      }
    }
    onProgress({ done: i + 1, total: items.length, current: item, results: [...results] });
  }

  return results;
}
