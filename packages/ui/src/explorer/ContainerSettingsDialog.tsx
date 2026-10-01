/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { useEffect, useState } from 'react';
import { resolveInheritedAuth } from '@httpreq/api-client';
import { findNode } from '@httpreq/workspace';
import { AppModal } from '../AppModal';
import { AuthorizationPanel } from '../auth/AuthorizationPanel';
import { useWorkbenchStore } from '../store';
import { Button, Select, Stack, Textarea, TextInput } from '../kit';

/**
 * Settings of a collection or folder. Its authorization is what requests (and sub-folders) set
 * to “Inherit from Parent” use. Changes apply immediately, like other structural edits.
 */
export function ContainerSettingsDialog({
    nodeId,
    onClose,
}: {
    nodeId: string | null;
    onClose: () => void;
}) {
    const workspace = useWorkbenchStore((state) => state.workspace);
    const updateContainer = useWorkbenchStore((state) => state.updateContainer);
    const renameNode = useWorkbenchStore((state) => state.renameNode);
    const revealNode = useWorkbenchStore((state) => state.revealNode);
    const linkEnvironment = useWorkbenchStore((state) => state.linkEnvironment);
    const found = nodeId ? findNode(workspace, nodeId) : undefined;
    const node =
        found && (found.kind === 'collection' || found.kind === 'folder') ? found : undefined;
    const [name, setName] = useState('');

    useEffect(() => {
        if (node) setName(node.node.name);
        // Only reset the field when a different node is opened.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodeId]);

    if (!node) return <AppModal opened={false} onClose={onClose} title={null} />;
    const { kind } = node;
    const inherited = resolveInheritedAuth(
        workspace,
        kind === 'folder' ? node.node.parentId : null,
    );

    return (
        <AppModal
            opened
            onClose={onClose}
            title={kind === 'collection' ? 'Collection settings' : 'Folder settings'}
            size="lg"
            footer={
                <Button
                    onClick={() => {
                        renameNode(node.node.id, name);
                        onClose();
                    }}
                >
                    Done
                </Button>
            }
        >
            <Stack gap="md">
                <TextInput
                    label="Name"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    onBlur={() => renameNode(node.node.id, name)}
                    onKeyDown={(event) => event.key === 'Enter' && renameNode(node.node.id, name)}
                />
                <Textarea
                    label="Description"
                    value={node.node.description}
                    onChange={(event) =>
                        updateContainer(node.node.id, { description: event.currentTarget.value })
                    }
                    autosize
                    minRows={2}
                    maxRows={6}
                />
                <Select
                    label="Environment"
                    description={`Activated whenever this ${kind} or a request in it is selected. A request can link its own environment instead.`}
                    placeholder="No environment"
                    clearable
                    value={node.node.environmentId ?? null}
                    data={workspace.environments.map((environment) => ({
                        value: environment.id,
                        label: environment.name,
                    }))}
                    onChange={(value) => linkEnvironment(node.node.id, value)}
                />
                <AuthorizationPanel
                    auth={node.node.auth}
                    onChange={(auth) => updateContainer(node.node.id, { auth })}
                    inherited={inherited}
                    canInherit={kind === 'folder'}
                    owner={kind}
                    onShowSource={(id) => {
                        onClose();
                        revealNode(id);
                    }}
                />
            </Stack>
        </AppModal>
    );
}
