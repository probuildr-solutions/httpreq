import { create } from 'zustand';

/**
 * `save-as` files an HTTP or WebSocket request under a name in a collection or folder; `move`
 * picks a new parent for a request or folder (the keyboard alternative to dragging it).
 */
export interface SaveAsTarget {
  mode: 'save-as' | 'move';
  id: string;
}

interface SaveAsDialogState {
  opened: boolean;
  /** Kept after closing, so the dialog does not go blank while it fades out. */
  target: SaveAsTarget | null;
}

export const useSaveAsDialog = create<SaveAsDialogState>(() => ({ opened: false, target: null }));

export const openSaveAsDialog = (target: SaveAsTarget) =>
  useSaveAsDialog.setState({ opened: true, target });

export const closeSaveAsDialog = () => useSaveAsDialog.setState({ opened: false });
