import * as React from 'react';
import { create } from 'zustand';
import type { UpdateStatus } from '../../shared/update.js';
import { getBridge } from './bridge.js';

interface UpdateStore {
  status: UpdateStatus | null;
  /** The update panel in the title bar is open. */
  open: boolean;
  setStatus: (status: UpdateStatus) => void;
  setOpen: (open: boolean) => void;
}

/** The app updater's state, as main reports it. */
export const useUpdate = create<UpdateStore>((set) => ({
  status: null,
  open: false,
  setStatus: (status) => set({ status }),
  setOpen: (open) => set({ open })
}));

/** Keep the store in step with main. Mount once. */
export function useUpdateWiring(): void {
  React.useEffect(() => {
    const bridge = getBridge();
    if (bridge === null) return;
    void bridge.updateStatus().then((status) => useUpdate.getState().setStatus(status));
    return bridge.onUpdate((status) => useUpdate.getState().setStatus(status));
  }, []);
}

/** Open the panel, checking first when nothing newer is known yet. */
export function showUpdate(): void {
  const { status, setOpen } = useUpdate.getState();
  setOpen(true);
  const kind = status?.state.kind;
  if (kind === 'idle' || kind === 'error') void getBridge()?.checkForUpdates();
}
