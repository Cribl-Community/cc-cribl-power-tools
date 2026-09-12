import { describe, expect, it } from 'vitest';
import {
  aggregateMatches,
  compileMatcher,
  extractFunctions,
  sortMatches,
  summarize,
  type GroupPipelines,
} from './functionFinder';
import type { Pipeline } from '../api/types';

/** Small helper to build a pipeline with a list of functions. */
function pipeline(id: string, functions: unknown[]): Pipeline {
  return { id, conf: { functions } } as Pipeline;
}

const GROUPS: GroupPipelines[] = [
  {
    groupId: 'g1',
    groupName: 'Group One',
    pipelines: [
      pipeline('pl_ingest', [
        { id: 'eval' },
        { id: 'sampling', description: 'downsample noisy logs' },
        { id: 'mask', disabled: true },
      ]),
      pipeline('pl_route', [{ id: 'sampling', disabled: true }, { id: 'drop' }]),
    ],
  },
  {
    groupId: 'g2',
    groupName: 'Group Two',
    pipelines: [pipeline('pl_metrics', [{ id: 'aggregation' }, { id: 'sampling' }])],
  },
];

/** Match everything against the (id, description) fields with the given matcher. */
function run(query: string, regex = false, caseSensitive = false, enabledOnly = false) {
  const m = compileMatcher(query, { regex, caseSensitive });
  if (!m.ok) throw new Error('expected matcher to compile');
  return aggregateMatches(GROUPS, m.test, { enabledOnly });
}

describe('compileMatcher', () => {
  it('does a case-insensitive substring match by default', () => {
    const m = compileMatcher('SAMP', { regex: false, caseSensitive: false });
    expect(m.ok && m.test('sampling')).toBe(true);
    expect(m.ok && m.test('eval')).toBe(false);
  });

  it('honours the case-sensitive toggle', () => {
    const m = compileMatcher('SAMP', { regex: false, caseSensitive: true });
    expect(m.ok && m.test('sampling')).toBe(false);
    expect(m.ok && m.test('SAMPLING is fun')).toBe(true);
  });

  it('compiles a valid regex', () => {
    const m = compileMatcher('^ma(sk|th)$', { regex: true, caseSensitive: false });
    expect(m.ok && m.test('mask')).toBe(true);
    expect(m.ok && m.test('math')).toBe(true);
    expect(m.ok && m.test('masking')).toBe(false);
  });

  it('returns an inline error (never throws) on an invalid regex', () => {
    const m = compileMatcher('(unclosed', { regex: true, caseSensitive: false });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error).toMatch(/invalid regular expression/i);
  });

  it('matches everything when the query is empty', () => {
    const m = compileMatcher('', { regex: true, caseSensitive: true });
    expect(m.ok && m.test('anything')).toBe(true);
  });
});

describe('extractFunctions', () => {
  it('returns [] for missing/malformed conf', () => {
    expect(extractFunctions({ id: 'p' } as Pipeline)).toEqual([]);
    expect(extractFunctions({ id: 'p', conf: {} } as Pipeline)).toEqual([]);
    expect(extractFunctions({ id: 'p', conf: { functions: 'nope' } } as unknown as Pipeline)).toEqual(
      [],
    );
  });

  it('drops entries without a string id', () => {
    const fns = extractFunctions(
      pipeline('p', [{ id: 'eval' }, { notId: true }, null, { id: 42 }]),
    );
    expect(fns.map((f) => f.id)).toEqual(['eval']);
  });
});

describe('aggregateMatches', () => {
  it('finds every "samp" function across all groups and pipelines', () => {
    const matches = run('samp');
    // sampling appears in pl_ingest (g1), pl_route (g1, disabled), pl_metrics (g2)
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => `${m.groupId}/${m.pipelineId}`).sort()).toEqual([
      'g1/pl_ingest',
      'g1/pl_route',
      'g2/pl_metrics',
    ]);
  });

  it('records enabled state from the per-function disabled flag', () => {
    const matches = run('samp');
    const route = matches.find((m) => m.pipelineId === 'pl_route');
    const ingest = matches.find((m) => m.pipelineId === 'pl_ingest');
    expect(route?.enabled).toBe(false);
    expect(ingest?.enabled).toBe(true);
  });

  it('enabled-only excludes disabled functions', () => {
    const matches = run('samp', false, false, true);
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.enabled)).toBe(true);
    expect(matches.some((m) => m.pipelineId === 'pl_route')).toBe(false);
  });

  it('records the function position within the pipeline', () => {
    const matches = run('samp');
    expect(matches.find((m) => m.pipelineId === 'pl_ingest')?.index).toBe(1);
    expect(matches.find((m) => m.pipelineId === 'pl_metrics')?.index).toBe(1);
  });

  it('matches against the description as well as the type id', () => {
    const matches = run('noisy');
    expect(matches).toHaveLength(1);
    expect(matches[0].functionType).toBe('sampling');
    expect(matches[0].description).toBe('downsample noisy logs');
  });

  it('filters correctly with a regex', () => {
    const matches = run('^ma(sk|th)$', true);
    expect(matches).toHaveLength(1);
    expect(matches[0].functionType).toBe('mask');
  });

  it('aggregates across groups and returns an empty list for no matches', () => {
    expect(run('nothingmatchesthis')).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts matches, distinct pipelines, and distinct groups', () => {
    const summary = summarize(run('samp'));
    expect(summary).toEqual({ matchCount: 3, pipelineCount: 3, groupCount: 2 });
  });

  it('does not conflate same-named pipelines in different groups', () => {
    const groups: GroupPipelines[] = [
      { groupId: 'a', groupName: 'A', pipelines: [pipeline('shared', [{ id: 'eval' }])] },
      { groupId: 'b', groupName: 'B', pipelines: [pipeline('shared', [{ id: 'eval' }])] },
    ];
    const m = compileMatcher('eval', { regex: false, caseSensitive: false });
    const matches = m.ok ? aggregateMatches(groups, m.test, { enabledOnly: false }) : [];
    expect(summarize(matches)).toEqual({ matchCount: 2, pipelineCount: 2, groupCount: 2 });
  });
});

describe('sortMatches', () => {
  it('sorts by the chosen key with deterministic tie-breaking', () => {
    const sorted = sortMatches(run('samp'), 'pipelineId');
    expect(sorted.map((m) => m.pipelineId)).toEqual(['pl_ingest', 'pl_metrics', 'pl_route']);
  });

  it('groups matches by function type when sorted by functionType', () => {
    const all = run('a'); // matches eval? no. matches aggregation, sampling, mask, drop -> those containing 'a'
    const sorted = sortMatches(all, 'functionType');
    const types = sorted.map((m) => m.functionType);
    // Verify the array is non-decreasing by functionType.
    const isSorted = types.every((t, i) => i === 0 || types[i - 1] <= t);
    expect(isSorted).toBe(true);
  });
});
