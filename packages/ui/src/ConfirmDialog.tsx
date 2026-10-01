/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */
import { AppModal } from './AppModal';
import { settleConfirm, useConfirmStore } from './confirm';
import { Button, Text } from './kit';
import { Z_LAYERS } from './zLayers';

/**
 * Renders the pending `confirmAction` request, if any.
 *
 * A confirmation is often raised from inside another dialog, so it takes its own layer rather
 * than relying on which portal happens to be later in the DOM.
 */
export function ConfirmDialog() {
    const request = useConfirmStore((state) => state.request);
    return (
        <AppModal
            opened={!!request}
            onClose={() => settleConfirm('cancel')}
            title={request?.title}
            size="sm"
            zIndex={Z_LAYERS.confirm}
            centered
            footer={
                request && (
                    <>
                        <Button variant="default" onClick={() => settleConfirm('cancel')}>
                            Cancel
                        </Button>
                        {request.alternateLabel && (
                            <Button
                                variant="default"
                                color="red"
                                onClick={() => settleConfirm('alternate')}
                            >
                                {request.alternateLabel}
                            </Button>
                        )}
                        <Button
                            color={request.danger ? 'red' : undefined}
                            onClick={() => settleConfirm('confirm')}
                            data-autofocus
                        >
                            {request.confirmLabel}
                        </Button>
                    </>
                )
            }
        >
            {request && <Text size="sm">{request.message}</Text>}
        </AppModal>
    );
}
