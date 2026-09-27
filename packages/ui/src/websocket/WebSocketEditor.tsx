import {
  ActionIcon,
  Alert,
  Button,
  Menu,
  NumberInput,
  SegmentedControl,
  Stack,
  Switch,
  Tabs,
  TagsInput,
  Text,
  Textarea,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCopy,
  IconCopyPlus,
  IconDeviceFloppy,
  IconDots,
  IconPlugConnected,
  IconPlugConnectedX,
  IconRefresh,
  IconSend,
} from '@tabler/icons-react';
import { useCallback, useMemo, useState } from 'react';
import { resolveInheritedAuth } from '@httpreq/api-client';
import { getAncestors, paramsFromUrl, urlWithParams } from '@httpreq/workspace';
import {
  WEBSOCKET_PAYLOAD_TYPES,
  type AuthConfig,
  type KeyValueItem,
  type WebSocketPayloadType,
  type WebSocketRequest,
  type WebSocketStatus,
} from '@httpreq/shared';
import { AuthorizationPanel } from '../auth/AuthorizationPanel';
import { useCapabilities } from '../capabilities';
import { emptySocket, useConnectionsStore } from '../connections';
import { Breadcrumb } from '../editor/Breadcrumb';
import { CodeEditor } from '../editor/CodeEditor';
import { KeyValueTable } from '../editor/KeyValueTable';
import { VariableInput } from '../editor/VariableInput';
import { ScrollableTabsList } from '../ScrollableTabsList';
import { WorkbenchSplit } from '../WorkbenchSplit';
import { useWorkbenchStore } from '../store';
import { MessageList } from './MessageList';
import { useWebSocketApi } from './useWebSockets';
import classes from './WebSocket.module.css';

const STATUS_LABEL: Record<WebSocketStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnecting: 'Disconnecting…',
  error: 'Error',
};

/** Monaco language for the composer, so JSON and XML get highlighting and folding. */
const LANGUAGE: Record<WebSocketPayloadType, string> = {
  text: 'plaintext',
  json: 'json',
  xml: 'xml',
  binary: 'plaintext',
};

const PLACEHOLDER: Record<WebSocketPayloadType, string> = {
  text: 'Message text',
  json: '{ "type": "ping" }',
  xml: '<message />',
  binary: 'Hexadecimal bytes, e.g. 48 65 6c 6c 6f',
};

interface Props {
  requestId: string;
  /** Files a request that is in no collection yet (via Save as); otherwise writes it to disk. */
  onSave?: () => void;
  /** Saves under a new name or in another collection or folder. */
  onSaveAs?: () => void;
  shortcuts?: { save?: string; saveAs?: string };
}

/**
 * The WebSocket request editor: connection controls, the same params/headers/auth surface as an
 * HTTP request, a message composer and the message log.
 *
 * Unlike HTTP requests, edits here are committed to the workspace immediately (as environments
 * are), so a socket request has no unsaved state to lose when its tab closes. Saving is about
 * where it lives: Save files a draft socket into a collection, Save as copies it elsewhere.
 */
export function WebSocketEditor({ requestId, onSave, onSaveAs, shortcuts = {} }: Props) {
  const workspace = useWorkbenchStore((state) => state.workspace);
  const edit = useWorkbenchStore((state) => state.editWebSocketRequest);
  const renameNode = useWorkbenchStore((state) => state.renameNode);
  const revealNode = useWorkbenchStore((state) => state.revealNode);
  const duplicateNode = useWorkbenchStore((state) => state.duplicateNode);
  const request = workspace.websocketRequests.find((item) => item.id === requestId);
  const socket = useConnectionsStore((state) => state.sockets[requestId]) ?? emptySocket();
  const api = useWebSocketApi();
  const capabilities = useCapabilities();
  const [tab, setTab] = useState<string | null>('params');

  const path = useMemo(() => getAncestors(workspace, requestId), [workspace, requestId]);
  const inherited = useMemo(
    () => resolveInheritedAuth(workspace, request?.parentId ?? null),
    [workspace, request?.parentId],
  );

  const patch = useCallback(
    (changes: Partial<WebSocketRequest>) => edit(requestId, changes),
    [edit, requestId],
  );

  if (!request) return null;

  const { status } = socket;
  const busy = status === 'connecting' || status === 'disconnecting';
  const connected = status === 'connected';

  const onUrlChange = (url: string) => patch({ url, params: paramsFromUrl(url, request.params) });
  const onParamsChange = (params: KeyValueItem[]) =>
    patch({ params, url: urlWithParams(request.url, params) });

  const send = () => api.send(request, request.draftPayloadType, request.draftMessage);
  // Edits are committed as they are made, so a socket in a collection is always saved.
  const filed = request.parentId !== null;
  const saveTitle = filed
    ? 'Saved — WebSocket changes are saved as you make them'
    : `Save to a collection${shortcuts.save ? ` (${shortcuts.save})` : ''}`;

  return (
    <WorkbenchSplit
      requestId="websocket-config"
      labels={{ request: 'WebSocket request', response: 'WebSocket messages' }}
      splitterLabel="Resize the WebSocket configuration and message log"
      busy={busy}
      request={
        <div className={classes.panel}>
          <Breadcrumb
            path={path}
            name={request.name}
            onSelect={revealNode}
            onRename={(name) => renameNode(requestId, name)}
          />
          <div className={classes.urlBar}>
            <Text size="xs" fw={700} c="violet" aria-hidden>
              WS
            </Text>
            <VariableInput
              className={classes.url}
              value={request.url}
              onChange={onUrlChange}
              mono
              completion
              placeholder="wss://example.com/socket"
              aria-label="WebSocket URL"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !connected && !busy) void api.connect(request);
              }}
            />
            <span className={classes.status} data-status={status}>
              <span className={classes.dot} aria-hidden />
              <span aria-live="polite">{STATUS_LABEL[status]}</span>
            </span>
            {connected || busy ? (
              <Button
                variant="default"
                size="xs"
                leftSection={<IconPlugConnectedX size={15} />}
                onClick={() => api.disconnect(requestId)}
              >
                Disconnect
              </Button>
            ) : (
              <Button
                size="xs"
                leftSection={<IconPlugConnected size={15} />}
                disabled={!request.url.trim()}
                onClick={() => void api.connect(request)}
              >
                Connect
              </Button>
            )}
            <Tooltip label="Reconnect">
              <Button
                variant="subtle"
                color="gray"
                size="xs"
                px={8}
                aria-label="Reconnect"
                disabled={!request.url.trim() || busy}
                onClick={() => void api.reconnect(request)}
              >
                <IconRefresh size={15} />
              </Button>
            </Tooltip>
            {onSave && (
              <Tooltip label={saveTitle}>
                <Button
                  variant="default"
                  size="xs"
                  leftSection={<IconDeviceFloppy size={15} />}
                  data-state={filed ? 'saved' : 'modified'}
                  aria-keyshortcuts={shortcuts.save}
                  onClick={onSave}
                >
                  {filed ? 'Saved' : 'Save'}
                </Button>
              </Tooltip>
            )}
            <Menu position="bottom-end" withinPortal shadow="md" width={220}>
              <Menu.Target>
                <ActionIcon variant="default" size={30} aria-label="More WebSocket actions">
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {onSaveAs && (
                  <Menu.Item
                    leftSection={<IconCopyPlus size={15} />}
                    rightSection={shortcuts.saveAs}
                    onClick={onSaveAs}
                  >
                    Save as…
                  </Menu.Item>
                )}
                <Menu.Item
                  leftSection={<IconCopy size={15} />}
                  onClick={() => duplicateNode(requestId)}
                >
                  Duplicate request
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </div>

          {socket.error && (
            <Alert
              color="red"
              variant="light"
              radius={0}
              icon={<IconAlertTriangle size={16} />}
              title="Connection problem"
            >
              {socket.error}
            </Alert>
          )}

          <Tabs
            value={tab}
            onChange={setTab}
            keepMounted={false}
            style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}
          >
            <ScrollableTabsList active={tab} aria-label="WebSocket request">
              <Tabs.Tab value="params">Params</Tabs.Tab>
              <Tabs.Tab value="headers">Headers</Tabs.Tab>
              <Tabs.Tab value="authorization">Authorization</Tabs.Tab>
              <Tabs.Tab value="settings">Settings</Tabs.Tab>
            </ScrollableTabsList>

            <div className={classes.tabsBody}>
              <Tabs.Panel value="params">
                <KeyValueTable
                  items={request.params}
                  onChange={onParamsChange}
                  label="Query parameters"
                  keyPlaceholder="Parameter"
                  allowSecret
                />
              </Tabs.Panel>

              <Tabs.Panel value="headers">
                <Stack gap="xs">
                  {!capabilities.webSocketHeaders && (
                    <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={16} />}>
                      Browsers cannot send handshake headers. These are kept with the request and
                      are sent by the HttpReq desktop app; in the browser, use a query parameter or
                      a subprotocol instead.
                    </Alert>
                  )}
                  <KeyValueTable
                    items={request.headers}
                    onChange={(headers) => patch({ headers })}
                    label="Handshake headers"
                    keyPlaceholder="Header"
                    allowSecret
                  />
                  <TagsInput
                    label="Subprotocols"
                    description="Offered as Sec-WebSocket-Protocol during the handshake."
                    placeholder="Add a subprotocol"
                    value={request.subprotocols}
                    onChange={(subprotocols) => patch({ subprotocols })}
                  />
                </Stack>
              </Tabs.Panel>

              <Tabs.Panel value="authorization">
                <AuthorizationPanel
                  auth={request.auth}
                  onChange={(auth: AuthConfig) => patch({ auth })}
                  inherited={inherited}
                  canInherit={request.parentId !== null}
                  owner="WebSocket request"
                />
              </Tabs.Panel>

              <Tabs.Panel value="settings">
                <Stack gap="md" maw={520}>
                  <NumberInput
                    label="Handshake timeout"
                    description="Milliseconds to wait for the server to accept the connection. 0 waits indefinitely."
                    min={0}
                    step={1000}
                    value={request.settings.handshakeTimeoutMs}
                    onChange={(value) =>
                      patch({
                        settings: {
                          ...request.settings,
                          handshakeTimeoutMs: typeof value === 'number' ? value : 0,
                        },
                      })
                    }
                  />
                  <Switch
                    label="Verify TLS certificate"
                    description={
                      capabilities.desktop
                        ? 'Turn off only for a server with a self-signed certificate you trust.'
                        : 'Controlled by the browser; this setting applies in the desktop app.'
                    }
                    disabled={!capabilities.desktop}
                    checked={request.settings.verifyTls}
                    onChange={(event) =>
                      patch({
                        settings: { ...request.settings, verifyTls: event.currentTarget.checked },
                      })
                    }
                  />
                  <Switch
                    label="Reconnect automatically"
                    description="Reconnects after an unclean close, such as a dropped network."
                    checked={request.settings.autoReconnect}
                    onChange={(event) =>
                      patch({
                        settings: {
                          ...request.settings,
                          autoReconnect: event.currentTarget.checked,
                        },
                      })
                    }
                  />
                  <NumberInput
                    label="Reconnect delay"
                    description="Milliseconds between reconnect attempts."
                    min={250}
                    step={250}
                    disabled={!request.settings.autoReconnect}
                    value={request.settings.reconnectDelayMs}
                    onChange={(value) =>
                      patch({
                        settings: {
                          ...request.settings,
                          reconnectDelayMs: typeof value === 'number' ? value : 2000,
                        },
                      })
                    }
                  />
                  <NumberInput
                    label="Message history limit"
                    description="Oldest messages are dropped once the log reaches this many."
                    min={10}
                    max={10_000}
                    step={50}
                    value={request.settings.messageLimit}
                    onChange={(value) =>
                      patch({
                        settings: {
                          ...request.settings,
                          messageLimit: typeof value === 'number' ? value : 500,
                        },
                      })
                    }
                  />
                </Stack>
              </Tabs.Panel>
            </div>
          </Tabs>
        </div>
      }
      response={
        <div className={classes.panel}>
          <MessageList
            messages={socket.messages}
            status={status}
            onClear={() => api.clear(requestId)}
          />
          <div className={classes.composer}>
            <div className={classes.composerRow}>
              <SegmentedControl
                size="xs"
                value={request.draftPayloadType}
                onChange={(value) => patch({ draftPayloadType: value as WebSocketPayloadType })}
                data={WEBSOCKET_PAYLOAD_TYPES.map((type) => ({
                  value: type,
                  label: type.toUpperCase(),
                }))}
                aria-label="Payload type"
              />
              <div style={{ flex: 1 }} />
              <Button
                size="xs"
                leftSection={<IconSend size={15} />}
                disabled={!connected || !request.draftMessage}
                onClick={send}
              >
                Send
              </Button>
            </div>
            {request.draftPayloadType === 'text' || request.draftPayloadType === 'binary' ? (
              <Textarea
                autosize
                minRows={3}
                maxRows={10}
                aria-label="Message to send"
                placeholder={PLACEHOLDER[request.draftPayloadType]}
                value={request.draftMessage}
                onChange={(event) => patch({ draftMessage: event.currentTarget.value })}
                onKeyDown={(event) => {
                  // Ctrl/Cmd+Enter sends, so Enter can still add a line to the message.
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && connected) {
                    event.preventDefault();
                    send();
                  }
                }}
              />
            ) : (
              // One editor for JSON and XML: switching format changes its language, not the editor.
              <CodeEditor
                className={classes.composerEditor}
                value={request.draftMessage}
                onChange={(value) => patch({ draftMessage: value })}
                language={LANGUAGE[request.draftPayloadType]}
                ariaLabel="Message to send"
              />
            )}
          </div>
        </div>
      }
    />
  );
}
