import { Badge, Button, Loader, Text } from '@mantine/core';
import { IconPlayerStop } from '@tabler/icons-react';
import { Fragment, memo, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { SseEvent } from '@httpreq/shared';
import classes from './ResponsePanel.module.css';

interface Props {
  events: readonly SseEvent[];
  /** Older events that were dropped to keep the list bounded. */
  dropped: number;
  /** The stream is still open and receiving. */
  live: boolean;
  /** How a finished stream ended. */
  ended?: 'closed' | 'stopped';
  onStop: () => void;
  query: string;
  /** Zero-based index of the highlighted match. */
  current: number;
  onMatchCount: (count: number) => void;
}

/** Wraps case-insensitive occurrences of `query` in `<mark>`s the search bar can step through. */
const highlight = (text: string, query: string): ReactNode => {
  if (!query) return text;
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let found = false;
  for (;;) {
    const at = lower.indexOf(needle, from);
    if (at < 0) break;
    found = true;
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} data-find>
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  if (!found) return text;
  if (from < text.length) parts.push(text.slice(from));
  return parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
};

const seconds = (ms: number) => `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;

const EventRow = memo(function EventRow({ item, query }: { item: SseEvent; query: string }) {
  return (
    <div className={classes.event}>
      <div className={classes.eventMeta}>
        <span className={classes.eventIndex}>#{item.index}</span>
        <Badge size="xs" radius="xs" variant="light" color={item.event ? 'violet' : 'gray'}>
          {highlight(item.event ?? 'message', query)}
        </Badge>
        {item.id !== undefined && (
          <Badge size="xs" radius="xs" variant="outline" color="gray" title="Event id">
            id {highlight(item.id, query)}
          </Badge>
        )}
        {item.retry !== undefined && (
          <Badge size="xs" radius="xs" variant="outline" color="gray" title="Reconnection time">
            retry {item.retry} ms
          </Badge>
        )}
        <span className={classes.eventTime}>{seconds(item.receivedAt)}</span>
      </div>
      <pre className={`hr-mono ${classes.eventData}`}>{highlight(item.data, query)}</pre>
    </div>
  );
});

/**
 * The body of a Server-Sent Events response: one row per event with its `event`, `id` and `data`
 * fields. While the stream is open the list follows the newest event unless the user has scrolled
 * up to read, and the stream can be stopped from the toolbar.
 */
export function StreamView({
  events,
  dropped,
  live,
  ended,
  onStop,
  query,
  current,
  onMatchCount,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  // Follow the newest event while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (live && follow.current && element) element.scrollTop = element.scrollHeight;
  }, [events.length, live]);

  // Report the matches and bring the current one into view.
  useLayoutEffect(() => {
    const marks = scroller.current?.querySelectorAll<HTMLElement>('mark[data-find]') ?? [];
    onMatchCount(marks.length);
    marks.forEach((mark) => mark.removeAttribute('data-current'));
    const target = marks[Math.min(current, marks.length - 1)];
    if (target) {
      target.setAttribute('data-current', '');
      follow.current = false;
      target.scrollIntoView({ block: 'nearest' });
    }
  }, [events, query, current, onMatchCount]);

  return (
    <div className={classes.stream}>
      <div className={classes.streamStatus} role="status">
        {live ? (
          <>
            <Loader size={12} aria-hidden />
            <Text size="xs">Streaming… {events.length + dropped} events</Text>
            <Button
              size="compact-xs"
              variant="light"
              color="red"
              leftSection={<IconPlayerStop size={13} />}
              onClick={onStop}
            >
              Stop
            </Button>
          </>
        ) : (
          <Text size="xs" c="dimmed">
            {ended === 'stopped' ? 'Stream stopped' : 'Stream closed by the server'} ·{' '}
            {events.length + dropped} events
          </Text>
        )}
        {dropped > 0 && (
          <Text size="xs" c="dimmed">
            The oldest {dropped} events are not shown.
          </Text>
        )}
      </div>
      <div
        ref={scroller}
        className={classes.eventList}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
        tabIndex={0}
        aria-label="Stream events"
      >
        {events.length === 0 ? (
          <Text size="sm" c="dimmed" p="md">
            {live ? 'Connected. Waiting for events…' : 'The stream sent no events.'}
          </Text>
        ) : (
          events.map((item) => <EventRow key={item.index} item={item} query={query} />)
        )}
      </div>
    </div>
  );
}
