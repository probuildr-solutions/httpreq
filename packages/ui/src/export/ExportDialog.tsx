import { Alert, Button, Code, List, Radio, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconDownload } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { AppModal } from '../AppModal';
import { downloadText } from '../exchange';
import { useWorkbenchStore } from '../store';
import { closeExportDialog, setExportFormat, useExportDialog } from './exportDialogStore';
import {
  buildExport,
  EXPORT_FORMAT_INFO,
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportResult,
} from './formats';
import classes from './Export.module.css';

/**
 * Exports a collection or a request as an HttpReq file, a Postman v2.1 collection or an OpenAPI
 * 3.1 description. The file is built as the format is picked, so whatever the format cannot carry
 * is listed before anything is saved.
 */
export function ExportDialog() {
  const opened = useExportDialog((state) => state.opened);
  const target = useExportDialog((state) => state.target);
  const format = useExportDialog((state) => state.format);
  const workspace = useWorkbenchStore((state) => state.workspace);

  // Built only while open; the last result stays on screen while the dialog fades out.
  const [shown, setShown] = useState<ExportResult | null>(null);
  const live = useMemo(
    () => (opened && target ? buildExport(workspace, target, format) : null),
    [opened, workspace, target, format],
  );
  useEffect(() => {
    if (opened) setShown(live);
  }, [opened, live]);
  const result = opened ? live : shown;

  const subject = useMemo(() => {
    if (!target) return '';
    if (target.kind === 'request') return `request “${target.request.name}”`;
    const collection = workspace.collections.find((item) => item.id === target.id);
    return collection ? `collection “${collection.name}”` : 'collection';
  }, [target, workspace.collections]);

  const save = () => {
    if (!result) return;
    downloadText(result.fileName, result.text, result.mime);
    notifications.show({
      color: 'teal',
      message: `Exported ${subject} as ${EXPORT_FORMAT_INFO[format].label}.`,
    });
    closeExportDialog();
  };

  return (
    <AppModal
      opened={opened}
      onClose={closeExportDialog}
      title={`Export ${subject}`}
      size="lg"
      footer={
        <>
          <Button variant="default" onClick={closeExportDialog}>
            Cancel
          </Button>
          <Button leftSection={<IconDownload size={15} />} disabled={!result} onClick={save}>
            Export
          </Button>
        </>
      }
    >
      <Stack gap="md">
        <Radio.Group
          label="Format"
          value={format}
          onChange={(value) => setExportFormat(value as ExportFormat)}
        >
          <Stack gap={6} mt={6}>
            {EXPORT_FORMATS.map((id) => (
              <Radio.Card key={id} value={id} className={classes.card} radius="sm">
                <div className={classes.cardBody}>
                  <Radio.Indicator size="xs" />
                  <div>
                    <Text size="sm" fw={600}>
                      {EXPORT_FORMAT_INFO[id].label}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {EXPORT_FORMAT_INFO[id].description}
                    </Text>
                  </div>
                </div>
              </Radio.Card>
            ))}
          </Stack>
        </Radio.Group>

        {result ? (
          <Text size="xs" c="dimmed">
            Saves <Code>{result.fileName}</Code>. Literal passwords, tokens and secret values are
            removed; <Code>{'{{variable}}'}</Code> references are kept.
          </Text>
        ) : (
          <Text size="sm" c="red">
            There is nothing to export: the collection no longer exists.
          </Text>
        )}

        {result && result.warnings.length > 0 && (
          <Alert
            color="yellow"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            title="Not everything fits this format"
          >
            <List size="xs" spacing={2}>
              {result.warnings.map((warning) => (
                <List.Item key={warning}>{warning}</List.Item>
              ))}
            </List>
          </Alert>
        )}
      </Stack>
    </AppModal>
  );
}
