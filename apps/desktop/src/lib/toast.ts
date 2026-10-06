import { create } from 'zustand';
import { ApiError } from './bridge.js';

export interface Toast {
  id: number;
  tone: 'info' | 'success' | 'error';
  title: string;
  detail?: string | undefined;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    set((state) => ({ toasts: [...state.toasts.slice(-3), { ...toast, id }] }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) })), toast.tone === 'error' ? 8000 : 3500);
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((entry) => entry.id !== id) }))
}));

export function toast(tone: Toast['tone'], title: string, detail?: string): void {
  useToasts.getState().push({ tone, title, detail });
}

/** Show a failed action with the daemon's own message and hint. */
export function toastError(title: string, error: unknown): void {
  if (error instanceof ApiError) {
    toast('error', title, error.hint === undefined ? error.message : `${error.message} ${error.hint}`);
    return;
  }
  toast('error', title, error instanceof Error ? error.message : String(error));
}
