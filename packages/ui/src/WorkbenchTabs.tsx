import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { HttpMethod } from '@httpreq/shared';
import { useConnectionsStore } from './connections';
import { RequestTabs, type RequestTabsProps, type TabItem } from './RequestTabs';
import { useWorkbenchStore } from './store';

type Props = Omit<RequestTabsProps, 'requests' | 'unsavedIds'> & {
  /** The open tabs as saved: names, kinds and saved methods. */
  tabs: TabItem[];
};

/**
 * The tab strip plus its live decorations: a request's unsaved method and URL, the unsaved-changes
 * marker, and a WebSocket's connection status.
 *
 * Those change on every keystroke and on every socket event. Reading them here means such a change
 * re-renders a dozen tabs; reading them in the application shell (as it used to) re-rendered the
 * sidebar, the editor and the response pane as well, once per keystroke and once per message.
 */
export function WorkbenchTabs({ tabs, ...props }: Props) {
  const ids = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const drafted = useWorkbenchStore(
    useShallow((state) =>
      ids.flatMap((id): (string | undefined)[] => {
        const draft = state.drafts[id];
        return [draft?.method, draft?.url];
      }),
    ),
  );
  const unsavedIds = useWorkbenchStore(useShallow((state) => Object.keys(state.drafts)));
  const socketStatus = useConnectionsStore(
    useShallow((state) => ids.map((id) => state.sockets[id]?.status ?? 'disconnected')),
  );

  const unsaved = useMemo(() => new Set(unsavedIds), [unsavedIds]);
  const decorated = useMemo(
    () =>
      tabs.map((tab, index): TabItem => {
        if (tab.kind === 'request') {
          const method = drafted[index * 2] as HttpMethod | undefined;
          const url = drafted[index * 2 + 1];
          return method === undefined ? tab : { ...tab, method, url };
        }
        if (tab.kind === 'websocket') return { ...tab, status: socketStatus[index] };
        return tab;
      }),
    [tabs, drafted, socketStatus],
  );

  return <RequestTabs requests={decorated} unsavedIds={unsaved} {...props} />;
}
