import { describe, expect, it } from 'vitest';
import { useUiState } from './store.js';

describe('desktop store', () => {
  it('selects a session id', () => {
    const { select } = useUiState.getState();
    select('abc');
    expect(useUiState.getState().selectedId).toBe('abc');
    select(null);
    expect(useUiState.getState().selectedId).toBe(null);
  });

  it('stores sessions and candidates', () => {
    const { setSessions, setCandidates } = useUiState.getState();
    setSessions([]);
    setCandidates([]);
    expect(useUiState.getState().sessions).toEqual([]);
    expect(useUiState.getState().candidates).toEqual([]);
  });
});
