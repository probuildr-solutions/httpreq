import { ActionIcon, Button, Menu, Select, Tooltip } from '@mantine/core';
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
import { methodColor } from '../methods';
import { VariableInput } from './VariableInput';
import classes from './RequestEditor.module.css';

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
    <div className={classes.urlBar}>
      <div className={classes.urlGroup}>
        <Select
          aria-label="HTTP method"
          className={classes.method}
          value={method}
          data={HTTP_METHODS as unknown as string[]}
          allowDeselect={false}
          withCheckIcon={false}
          onChange={(value) => value && onMethodChange(value as HttpMethod)}
          comboboxProps={{
            withinPortal: true,
            width: 120,
            middlewares: { flip: true, shift: true },
          }}
          renderOption={({ option }) => (
            <span
              className={classes.methodOption}
              style={{
                color: `var(--mantine-color-${methodColor[option.value as HttpMethod]}-text)`,
              }}
            >
              {option.value}
            </span>
          )}
          styles={{
            input: {
              color: `var(--mantine-color-${methodColor[method]}-text)`,
              fontWeight: 700,
            },
          }}
        />
        <VariableInput
          ref={urlRef}
          className={classes.url}
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
          className={classes.saveButton}
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
        >
          {saveLabels[saveState]}
        </Button>
      </Tooltip>

      {sending ? (
        <Button color="red" variant="light" onClick={onCancel} className={classes.sendButton}>
          Cancel
        </Button>
      ) : (
        <Tooltip label={`Send${sendShortcut ? ` (${sendShortcut})` : ''}`}>
          <Button
            onClick={onSend}
            rightSection={<IconSend size={14} />}
            aria-keyshortcuts={sendShortcut}
            className={classes.sendButton}
          >
            Send
          </Button>
        </Tooltip>
      )}

      <Menu position="bottom-end" withinPortal shadow="md" width={220}>
        <Menu.Target>
          <ActionIcon
            variant="default"
            size={30}
            aria-label="More request actions"
            className={classes.overflow}
          >
            <IconDots size={16} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            className={classes.overflowSave}
            leftSection={<IconDeviceFloppy size={15} />}
            rightSection={saveShortcut}
            onClick={onSave}
            disabled={saveState === 'saving'}
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
