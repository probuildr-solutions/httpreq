/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useAdmin } from './adminStore';
import { DocumentEditor } from './DocumentEditor';
import { IndexManager } from './IndexManager';
import { TriggerManager } from './TriggerManager';
import { ErDiagram } from './ErDiagram';
import { TableBrowser } from './TableBrowser';
import { TableDesigner } from './TableDesigner';

/** Renders the content of an admin tab by its kind. */
export function AdminTabView({ id }: { id: string }) {
    const kind = useAdmin((state) => state.tabs[id]?.kind);
    switch (kind) {
        case 'table':
            return <TableBrowser id={id} />;
        case 'design':
            return <TableDesigner id={id} />;
        case 'er':
            return <ErDiagram id={id} />;
        case 'documents':
            return <DocumentEditor id={id} />;
        case 'indexes':
            return <IndexManager id={id} />;
        case 'triggers':
            return <TriggerManager id={id} />;
        default:
            return null;
    }
}
