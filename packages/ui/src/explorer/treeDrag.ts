/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { create } from 'zustand';

/** Data type set on drags that carry a collection-tree node (from the explorer or a request tab). */
export const TREE_DRAG_TYPE = 'application/x-httpreq-node';

/**
 * The tree node being dragged, wherever the drag started: the explorer itself, or a request tab
 * dropped onto the explorer to file it. `dragover` cannot read a drag's data, so the id is kept
 * here for the whole drag.
 *
 * The id is readable at once through {@link draggedTreeNode}; the rendered copy in the store is
 * published a frame later, because changing the DOM inside `dragstart` can cancel the drag.
 */
export const useTreeDrag = create<{ id: string | null }>(() => ({ id: null }));

let current: string | null = null;
let frame = 0;

/** The node being dragged right now, readable synchronously during drag events. */
export const draggedTreeNode = () => current;

/** Records the dragged node at once; the reactive copy follows on the next frame so starting a
 * drag stays cheap.
 */
export const startTreeDrag = (id: string) => {
    current = id;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => useTreeDrag.setState({ id }));
};

/** Clears the drag state when a drag finishes or is cancelled. */
export const endTreeDrag = () => {
    current = null;
    cancelAnimationFrame(frame);
    useTreeDrag.setState({ id: null });
};
