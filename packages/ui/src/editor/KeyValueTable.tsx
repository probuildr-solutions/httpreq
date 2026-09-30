import {
  ActionIcon,
  Autocomplete,
  Button,
  Checkbox,
  Group,
  Text,
  Textarea,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import {
  IconChevronRight,
  IconCopy,
  IconLock,
  IconLockOpen,
  IconPencilPlus,
  IconShieldLock,
  IconTrash,
} from '@tabler/icons-react';
import { memo, useState, type ReactNode } from 'react';
import { createId, type KeyValueItem } from '@httpreq/shared';
import { VariableInput } from './VariableInput';
import { fromBulkText, toBulkText } from './bulk';
import classes from './KeyValueTable.module.css';

/**
 * A row the user cannot edit, shown in the same grid as the editable rows so the columns line up:
 * e.g. a header the authorization or the HTTP client adds when the request is sent.
 */
export interface LockedRow {
  id: string;
  key: string;
  value: string;
  /** Shown in the description column: where the row comes from. */
  description: string;
  /** Set when an editable row takes this one's place; the row is shown struck through. */
  overriddenBy?: string;
  /** Offered when an editable row may replace this one: adds that row. */
  onOverride?: () => void;
}

export interface KeyValueTableProps<T extends KeyValueItem> {
  items: T[];
  onChange: (items: T[]) => void;
  /** Builds a new row (e.g. to add fields specific to multipart rows). */
  createRow?: (patch: Partial<KeyValueItem>) => T;
  label: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  /** Suggestions for the key column (e.g. common header names). */
  keySuggestions?: readonly string[];
  /** Shows a per-row toggle that masks the value. */
  allowSecret?: boolean;
  showDescription?: boolean;
  allowBulkEdit?: boolean;
  /** Adds a Type column between Key and Value (e.g. Text / File for multipart fields). */
  renderType?: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  /** Replaces the value cell for a row (e.g. a file picker). */
  renderValue?: (item: T, update: (patch: Partial<T>) => void) => ReactNode | undefined;
  /** Extra per-row controls before the row actions (e.g. text/file switch). */
  renderRowExtras?: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
  /** Message shown in a row, e.g. that the header is replaced by authorization. */
  rowNote?: (item: T) => string | undefined;
  /** Read-only rows listed above the editable ones, under a heading that shows or hides them. */
  lockedRows?: readonly LockedRow[];
  /** Heading of the locked rows, e.g. "Auto-generated headers". */
  lockedLabel?: string;
  lockedHint?: string;
  lockedVisible?: boolean;
  onLockedVisibleChange?: (visible: boolean) => void;
}

const defaultCreate = (patch: Partial<KeyValueItem>) =>
  ({ id: createId(), key: '', value: '', enabled: true, ...patch }) as KeyValueItem;

/**
 * Structured `✓ | Key | Value | Description` editor. A trailing empty row turns into a real row
 * as soon as something is typed into it (keeping focus), so empty placeholder rows are never
 * stored or counted.
 */
function KeyValueTableInner<T extends KeyValueItem>({
  items,
  onChange,
  createRow = defaultCreate as unknown as (patch: Partial<KeyValueItem>) => T,
  label,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  keySuggestions,
  allowSecret = false,
  showDescription = true,
  allowBulkEdit = true,
  renderType,
  renderValue,
  renderRowExtras,
  rowNote,
  lockedRows,
  lockedLabel = 'Locked',
  lockedHint,
  lockedVisible = true,
  onLockedVisibleChange,
}: KeyValueTableProps<T>) {
  const [ghostId, setGhostId] = useState(createId);
  const [bulk, setBulk] = useState<string | null>(null);

  const update = (id: string, patch: Partial<T>) => {
    if (id === ghostId) {
      onChange([...items, { ...createRow({ id: ghostId }), ...patch }]);
      setGhostId(createId());
      return;
    }
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };
  const remove = (id: string) => onChange(items.filter((item) => item.id !== id));
  const duplicate = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const next = [...items];
    next.splice(index + 1, 0, { ...structuredClone(items[index]!), id: createId() });
    onChange(next);
  };

  const enabledCount = items.filter((item) => item.enabled && item.key.trim()).length;
  const allEnabled = items.length > 0 && items.every((item) => item.enabled);

  if (bulk !== null) {
    return (
      <div className={classes.root}>
        <Group justify="space-between" mb={6}>
          <Text size="xs" c="dimmed">
            One <code>key: value</code> per line. Prefix a line with <code>//</code> to disable it.
          </Text>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => {
              onChange(fromBulkText(bulk, items, createRow));
              setBulk(null);
            }}
          >
            Key-value edit
          </Button>
        </Group>
        <Textarea
          aria-label={`${label} (bulk edit)`}
          value={bulk}
          onChange={(event) => setBulk(event.currentTarget.value)}
          onBlur={() => onChange(fromBulkText(bulk, items, createRow))}
          autosize
          minRows={6}
          className="hr-mono"
          autoFocus
        />
      </div>
    );
  }

  const rows = [...items, { ...createRow({ id: ghostId }) }];
  const lockedCount = lockedRows?.filter((row) => !row.overriddenBy).length ?? 0;

  return (
    <div className={classes.root}>
      <div
        className={classes.table}
        role="table"
        aria-label={label}
        data-description={showDescription || undefined}
        data-typed={renderType ? true : undefined}
      >
        <div className={classes.header} role="row">
          <span role="columnheader" className={classes.check}>
            <Checkbox
              size="xs"
              aria-label={`Enable all ${label.toLowerCase()}`}
              checked={allEnabled}
              indeterminate={!allEnabled && items.some((item) => item.enabled)}
              disabled={!items.length}
              onChange={(event) =>
                onChange(items.map((item) => ({ ...item, enabled: event.currentTarget.checked })))
              }
            />
          </span>
          <span role="columnheader">Key</span>
          {renderType && <span role="columnheader">Type</span>}
          <span role="columnheader">Value</span>
          {showDescription && (
            <span role="columnheader" className={classes.description}>
              Description
            </span>
          )}
          <span role="columnheader" className={classes.actionsHeader}>
            {allowBulkEdit && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                onClick={() => setBulk(toBulkText(items))}
              >
                Bulk edit
              </Button>
            )}
          </span>
        </div>
        {lockedRows && lockedRows.length > 0 && (
          <div role="row" className={classes.groupRow}>
            <span role="cell" className={classes.groupCell}>
              <UnstyledButton
                className={classes.groupToggle}
                aria-expanded={lockedVisible}
                onClick={() => onLockedVisibleChange?.(!lockedVisible)}
              >
                <IconChevronRight
                  size={13}
                  className={classes.groupChevron}
                  data-open={lockedVisible || undefined}
                  aria-hidden
                />
                {lockedLabel}
                <span className={classes.groupCount}>{lockedCount}</span>
              </UnstyledButton>
              {lockedHint && (
                <Text component="span" size="xs" c="dimmed" className={classes.groupHint}>
                  {lockedHint}
                </Text>
              )}
            </span>
          </div>
        )}
        {lockedVisible &&
          lockedRows?.map((row) => (
            <div
              key={row.id}
              role="row"
              className={classes.row}
              data-locked
              data-overridden={row.overriddenBy ? true : undefined}
            >
              <span role="cell" className={classes.check}>
                <Tooltip label="Added automatically; not editable" openDelay={300}>
                  <IconShieldLock size={13} className={classes.lockIcon} aria-label="Read-only" />
                </Tooltip>
              </span>
              <span role="cell" className={classes.cell}>
                <span className={classes.lockedText} title={row.key}>
                  {row.key}
                </span>
              </span>
              {renderType && <span role="cell" className={classes.cell} />}
              <span role="cell" className={classes.cell}>
                <span className={classes.lockedText} title={row.value}>
                  {row.value}
                </span>
              </span>
              {showDescription && (
                <span role="cell" className={`${classes.cell} ${classes.description}`}>
                  <span className={classes.lockedNote} title={row.description}>
                    {row.overriddenBy
                      ? `Replaced by your “${row.overriddenBy}” header`
                      : row.description}
                  </span>
                </span>
              )}
              <span role="cell" className={classes.actions}>
                {row.onOverride && !row.overriddenBy && (
                  <Tooltip label="Override: add an editable copy">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label={`Override ${row.key}`}
                      onClick={row.onOverride}
                    >
                      <IconPencilPlus size={14} />
                    </ActionIcon>
                  </Tooltip>
                )}
              </span>
            </div>
          ))}
        {rows.map((item) => {
          const ghost = item.id === ghostId;
          const patch = (value: Partial<T>) => update(item.id, value);
          const note = ghost ? undefined : rowNote?.(item);
          const customValue = renderValue?.(item, patch);
          return (
            <div
              key={item.id}
              role="row"
              className={classes.row}
              data-disabled={(!ghost && !item.enabled) || undefined}
              data-ghost={ghost || undefined}
            >
              <span role="cell" className={classes.check}>
                {!ghost && (
                  <Checkbox
                    size="xs"
                    aria-label={`Enable ${item.key || 'row'}`}
                    checked={item.enabled}
                    onChange={(event) =>
                      patch({ enabled: event.currentTarget.checked } as Partial<T>)
                    }
                  />
                )}
              </span>
              <span role="cell" className={classes.cell}>
                {keySuggestions ? (
                  <Autocomplete
                    aria-label="Key"
                    placeholder={ghost ? `Add ${keyPlaceholder.toLowerCase()}` : keyPlaceholder}
                    value={item.key}
                    data={keySuggestions as string[]}
                    onChange={(key) => patch({ key } as Partial<T>)}
                    variant="unstyled"
                    size="xs"
                    classNames={{ input: classes.keyInput }}
                    comboboxProps={{ withinPortal: true, middlewares: { flip: true, shift: true } }}
                    limit={8}
                  />
                ) : (
                  <VariableInput
                    variant="cell"
                    aria-label="Key"
                    placeholder={ghost ? `Add ${keyPlaceholder.toLowerCase()}` : keyPlaceholder}
                    value={item.key}
                    onChange={(key) => patch({ key } as Partial<T>)}
                  />
                )}
              </span>
              {renderType && (
                <span role="cell" className={classes.cell}>
                  {renderType(item, patch)}
                </span>
              )}
              <span role="cell" className={classes.cell}>
                {customValue ?? (
                  <VariableInput
                    variant="cell"
                    aria-label="Value"
                    placeholder={valuePlaceholder}
                    value={item.value}
                    masked={!!item.secret}
                    onChange={(value) => patch({ value } as Partial<T>)}
                  />
                )}
              </span>
              {showDescription && (
                <span role="cell" className={`${classes.cell} ${classes.description}`}>
                  <VariableInput
                    variant="cell"
                    mono={false}
                    completion={false}
                    aria-label="Description"
                    placeholder="Description"
                    value={item.description ?? ''}
                    onChange={(description) => patch({ description } as Partial<T>)}
                  />
                </span>
              )}
              <span role="cell" className={classes.actions}>
                {!ghost && (
                  <>
                    {note && (
                      <Tooltip label={note} multiline maw={260}>
                        <span className={classes.note} tabIndex={0} aria-label={note}>
                          !
                        </span>
                      </Tooltip>
                    )}
                    {renderRowExtras?.(item, patch)}
                    {allowSecret && (
                      <Tooltip
                        label={
                          item.secret ? 'Secret: masked and not saved to disk' : 'Mark as secret'
                        }
                      >
                        <ActionIcon
                          variant="subtle"
                          color={item.secret ? 'violet' : 'gray'}
                          size="sm"
                          aria-label={item.secret ? 'Unmark secret' : 'Mark as secret'}
                          aria-pressed={!!item.secret}
                          onClick={() => patch({ secret: !item.secret } as Partial<T>)}
                        >
                          {item.secret ? <IconLock size={14} /> : <IconLockOpen size={14} />}
                        </ActionIcon>
                      </Tooltip>
                    )}
                    <Tooltip label="Duplicate">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="Duplicate row"
                        onClick={() => duplicate(item.id)}
                      >
                        <IconCopy size={14} />
                      </ActionIcon>
                    </Tooltip>
                    <Tooltip label="Remove">
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        size="sm"
                        aria-label="Remove row"
                        onClick={() => remove(item.id)}
                      >
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <Text size="xs" c="dimmed" mt={6} aria-live="polite">
        {enabledCount} enabled
      </Text>
    </div>
  );
}

export const KeyValueTable = memo(KeyValueTableInner) as typeof KeyValueTableInner;
