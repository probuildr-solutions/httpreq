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
import { CollectionDesigner } from './forms/CollectionDesigner';
import { EventEditor } from './forms/EventEditor';
import { RoutineEditor } from './forms/RoutineEditor';
import { TriggerEditor } from './forms/TriggerEditor';

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
        case 'trigger-editor':
            return <TriggerEditor id={id} />;
        case 'procedure-editor':
            return <RoutineEditor id={id} kind="procedure" />;
        case 'function-editor':
            return <RoutineEditor id={id} kind="function" />;
        case 'event-editor':
            return <EventEditor id={id} />;
        case 'collection-designer':
            return <CollectionDesigner id={id} />;
        default:
            return null;
    }
}
