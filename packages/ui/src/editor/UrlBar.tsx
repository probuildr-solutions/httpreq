/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    IconAlertTriangle,
    IconCopy,
    IconDeviceFloppy,
    IconCopyPlus,
    IconDots,
    IconSend,
    IconTerminal2,
} from '@tabler/icons-react';
import type { Ref } from 'react';
import { HTTP_METHODS, type HttpMethod } from '@httpreq/shared';
import { methodText } from '../methods';
import { VariableInput } from './VariableInput';
import { ActionIcon, Button, Menu, Select, Tooltip, cx } from '../kit';

export type SaveState = 'saved' | 'modified' | 'saving' | 'failed';

interface Props {
    method: HttpMethod;
    url: string;
    onMethodChange: (method: HttpMethod) => void;
    onUrlChange: (url: string) => void;
    urlRef?: Ref<HTMLInputElement>;
    sending: boolean;
    onSend: () => void;
    onCancel: () => void;
    saveState: SaveState;
    onSave: () => void;
    /** Saves the request under a new name or in another collection or folder. */
    onSaveAs?: () => void;
    onCopyCurl: () => void;
    onDuplicate: () => void;
    sendShortcut?: string;
    saveShortcut?: string;
    saveAsShortcut?: string;
    focusShortcut?: string;
}

const saveLabels: Record<SaveState, string> = {
    saved: 'Saved',
    modified: 'Save',
    saving: 'Saving…',
    failed: 'Retry save',
};

/**
 * `METHOD | URL | Save | Send`. Method, URL and Send always stay visible; on narrow panes Save
 * moves into the overflow menu (a container query, so it follows the request pane's width, not
 * the window's).
 */
export function UrlBar({
    method,
    url,
    onMethodChange,
    onUrlChange,
    urlRef,
    sending,
    onSend,
    onCancel,
    saveState,
    onSave,
    onSaveAs,
    onCopyCurl,
    onDuplicate,
    sendShortcut,
    saveShortcut,
    saveAsShortcut,
    focusShortcut,
}: Props) {
    const saveTitle =
        saveState === 'failed'
            ? 'The last save failed. Select to try again.'
            : saveState === 'saved'
              ? 'All changes are saved'
              : `Save${saveShortcut ? ` (${saveShortcut})` : ''}`;

    return (
        <div className="flex items-center gap-1.5 px-2.5 pt-1.5 pb-2 @max-[420px]/request-editor:flex-wrap">
            <div className="flex h-8 min-w-0 flex-1 rounded-sm border border-line bg-field focus-within:border-primary @max-[420px]/request-editor:basis-full">
                <Select
                    aria-label="HTTP method"
                    value={method}
                    data={HTTP_METHODS as unknown as string[]}
                    withCheckIcon={false}
                    variant="unstyled"
                    size="xs"
                    menuWidth={120}
                    onChange={(value) => value && onMethodChange(value as HttpMethod)}
                    renderOption={(option) => (
                        <span
                            className={cx(
                                'font-mono text-[12.5px] font-bold',
                                methodText[option.value as HttpMethod],
                            )}
                        >
                            {option.value}
                        </span>
                    )}
                    // Each verb is shown in its own colour, in the closed control too.
                    inputClassName={cx(
                        'h-[30px] font-mono text-[12.5px] font-bold focus-within:shadow-none!',
                        methodText[method],
                    )}
                    className="flex-[0_0_96px] border-r border-line @max-[380px]/request-editor:flex-[0_0_78px]"
                />
                <VariableInput
                    ref={urlRef}
                    className="flex-1 self-center focus-within:shadow-none!"
                    variant="cell"
                    aria-label="Request URL"
                    aria-keyshortcuts={focusShortcut}
                    placeholder="{{base_url}}/users or https://api.example.com/users"
                    value={url}
                    onChange={onUrlChange}
                    onKeyDown={(event) => {
                        if (
                            event.key === 'Enter' &&
                            !event.ctrlKey &&
                            !event.metaKey &&
                            !event.shiftKey &&
                            !event.altKey
                        ) {
                            event.preventDefault();
                            onSend();
                        }
                    }}
                />
            </div>

            <Tooltip label={saveTitle}>
                <Button
                    variant={saveState === 'failed' ? 'light' : 'default'}
                    color={saveState === 'failed' ? 'red' : undefined}
                    leftSection={
                        saveState === 'failed' ? (
                            <IconAlertTriangle size={15} />
                        ) : (
                            <IconDeviceFloppy size={15} />
                        )
                    }
                    loading={saveState === 'saving'}
                    data-state={saveState}
                    aria-keyshortcuts={saveShortcut}
                    onClick={onSave}
                    className={cx(
                        'h-8 flex-none @max-[560px]/request-editor:hidden',
                        saveState === 'saved' && 'text-dimmed',
                    )}
                >
                    {saveLabels[saveState]}
                </Button>
            </Tooltip>

            {sending ? (
                <Button
                    color="red"
                    variant="light"
                    onClick={onCancel}
                    className="h-8 flex-none @max-[420px]/request-editor:flex-1"
                >
                    Cancel
                </Button>
            ) : (
                <Tooltip label={`Send${sendShortcut ? ` (${sendShortcut})` : ''}`}>
                    <Button
                        onClick={onSend}
                        rightSection={<IconSend size={14} />}
                        aria-keyshortcuts={sendShortcut}
                        className="h-8 flex-none @max-[420px]/request-editor:flex-1"
                    >
                        Send
                    </Button>
                </Tooltip>
            )}

            <Menu position="bottom-end" width={220}>
                <Menu.Target>
                    <ActionIcon
                        variant="default"
                        size={30}
                        aria-label="More request actions"
                        className="hidden flex-none @max-[560px]/request-editor:flex"
                    >
                        <IconDots size={16} />
                    </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                    <Menu.Item
                        leftSection={<IconDeviceFloppy size={15} />}
                        rightSection={saveShortcut}
                        onClick={onSave}
                        disabled={saveState === 'saving'}
                        className="hidden @max-[560px]/request-editor:flex"
                    >
                        {saveState === 'saved' ? 'Saved' : 'Save'}
                    </Menu.Item>
                    {onSaveAs && (
                        <Menu.Item
                            leftSection={<IconCopyPlus size={15} />}
                            rightSection={saveAsShortcut}
                            onClick={onSaveAs}
                        >
                            Save as…
                        </Menu.Item>
                    )}
                    <Menu.Item leftSection={<IconTerminal2 size={15} />} onClick={onCopyCurl}>
                        Copy as cURL
                    </Menu.Item>
                    <Menu.Item leftSection={<IconCopy size={15} />} onClick={onDuplicate}>
                        Duplicate request
                    </Menu.Item>
                </Menu.Dropdown>
            </Menu>
        </div>
    );
}
