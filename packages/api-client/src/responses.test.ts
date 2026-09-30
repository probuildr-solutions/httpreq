import { describe, expect, it, vi } from 'vitest';
import type { HttpResponse, SseEvent } from '@httpreq/shared';
import {
  createSseParser,
  describeResponse,
  isBinaryBody,
  parseContentDisposition,
  responseBytes,
  serializeSseEvents,
  suggestedFileName,
} from './responses';
import { buildStreamResponse, readResponse } from './transport';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);

const response = (patch: Partial<HttpResponse>): HttpResponse => ({
  status: 200,
  statusText: 'OK',
  headers: {},
  body: '',
  contentType: 'text/plain',
  durationMs: 1,
  sizeBytes: 0,
  ...patch,
});

describe('parseContentDisposition', () => {
  it('reads attachment file names, quoted or not', () => {
    expect(parseContentDisposition('attachment; filename="report 2024.pdf"')).toEqual({
      type: 'attachment',
      fileName: 'report 2024.pdf',
    });
    expect(parseContentDisposition('attachment; filename=data.csv')).toEqual({
      type: 'attachment',
      fileName: 'data.csv',
    });
  });

  it('prefers the RFC 5987 extended name and decodes it', () => {
    expect(
      parseContentDisposition(
        'attachment; filename="fallback.txt"; filename*=UTF-8\'\'%E2%82%AC%20rates.txt',
      ).fileName,
    ).toBe('€ rates.txt');
  });

  it('keeps a semicolon inside a quoted name and strips directories', () => {
    expect(parseContentDisposition('attachment; filename="a;b.txt"').fileName).toBe('a;b.txt');
    expect(parseContentDisposition('attachment; filename="../../etc/passwd"').fileName).toBe(
      'passwd',
    );
  });

  it('handles inline and missing headers', () => {
    expect(parseContentDisposition('inline')).toEqual({ type: 'inline', fileName: null });
    expect(parseContentDisposition(undefined)).toEqual({ type: null, fileName: null });
  });
});

describe('isBinaryBody', () => {
  it('never treats text-like types as binary', () => {
    expect(isBinaryBody(text('{"a":1}'), 'application/json; charset=utf-8')).toBe(false);
    expect(isBinaryBody(text('<a/>'), 'application/vnd.api+xml')).toBe(false);
    expect(isBinaryBody(text('<svg/>'), 'image/svg+xml')).toBe(false);
  });

  it('always treats known binary types as binary', () => {
    expect(isBinaryBody(bytes(0x25, 0x50, 0x44, 0x46), 'application/pdf')).toBe(true);
    expect(isBinaryBody(text('PK'), 'application/zip')).toBe(true);
    expect(isBinaryBody(text('x'), 'image/png')).toBe(true);
    expect(
      isBinaryBody(text('x'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    ).toBe(true);
  });

  it('decides from the bytes when the type says nothing', () => {
    expect(isBinaryBody(text('just text'), 'application/octet-stream')).toBe(false);
    expect(
      isBinaryBody(bytes(0x50, 0x4b, 0x03, 0x04, 0x00, 0x01), 'application/octet-stream'),
    ).toBe(true);
    expect(isBinaryBody(bytes(0xff, 0xfe, 0xfd), '')).toBe(true);
  });
});

describe('describeResponse and file names', () => {
  it('reports filename, type and length from the headers', () => {
    const info = describeResponse(
      response({
        headers: {
          'Content-Disposition': 'attachment; filename="q3.xlsx"',
          'content-length': '2048',
        },
        contentType: 'application/vnd.ms-excel; charset=binary',
        sizeBytes: 2048,
        binary: true,
      }),
    );
    expect(info).toMatchObject({
      mimeType: 'application/vnd.ms-excel',
      fileName: 'q3.xlsx',
      contentLength: 2048,
      isDownload: true,
      binary: true,
    });
  });

  it('names a saved copy after the type when the server gave no name', () => {
    expect(suggestedFileName(response({ contentType: 'application/json' }))).toBe('response.json');
    expect(suggestedFileName(response({ contentType: 'application/pdf', binary: true }))).toBe(
      'response.pdf',
    );
    expect(suggestedFileName(response({ contentType: 'application/x-weird', binary: true }))).toBe(
      'response.bin',
    );
    expect(
      suggestedFileName(
        response({ headers: { 'content-disposition': 'attachment; filename=x.zip' } }),
      ),
    ).toBe('x.zip');
  });

  it('saves the received bytes, not a re-encoding of the text', () => {
    const original = bytes(0xef, 0xbb, 0xbf, 0x68, 0x69);
    expect(responseBytes(response({ body: 'hi', bytes: original }))).toBe(original);
    expect(responseBytes(response({ body: 'é' }))).toEqual(text('é'));
  });
});

describe('createSseParser', () => {
  const collect = (chunks: string[]) => {
    const parser = createSseParser();
    const events: SseEvent[] = [];
    chunks.forEach((chunk, index) => events.push(...parser.push(chunk, index)));
    events.push(...parser.flush(99));
    return events;
  };

  it('parses event, data and id fields', () => {
    const [first, second] = collect(['event: tick\nid: 7\ndata: {"n":1}\n\ndata: plain\n\n']);
    expect(first).toMatchObject({ index: 1, event: 'tick', id: '7', data: '{"n":1}' });
    expect(second).toMatchObject({ index: 2, data: 'plain' });
    expect(second!.event).toBeUndefined();
    expect(second!.id).toBeUndefined();
  });

  it('joins multi-line data, skips comments and handles retry', () => {
    const [event] = collect([': keep-alive\nretry: 3000\ndata: a\ndata: b\n\n']);
    expect(event).toMatchObject({ data: 'a\nb', retry: 3000 });
  });

  it('copes with events split across chunks and CRLF line ends', () => {
    const events = collect(['da', 'ta: hel', 'lo\r', '\n\r', '\ndata: x\r\n\r\n']);
    expect(events.map((item) => item.data)).toEqual(['hello', 'x']);
  });

  it('dispatches an event cut off by the end of the stream, but not an empty one', () => {
    expect(collect(['data: last'])).toHaveLength(1);
    expect(collect(['event: only-a-name\n\n'])).toHaveLength(0);
  });

  it('round-trips through serializeSseEvents', () => {
    const events = collect(['event: a\nid: 1\ndata: x\ndata: y\n\n']);
    expect(serializeSseEvents(events)).toBe('event: a\nid: 1\ndata: x\ndata: y\n\n');
  });
});

const streamOf = (chunks: string[], keepOpenAfter = false) => {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      chunks.forEach((chunk) => c.enqueue(encoder.encode(chunk)));
      if (!keepOpenAfter) c.close();
    },
  });
  return { body, controller: () => controller };
};

describe('readResponse', () => {
  it('keeps binary bodies as bytes and never decodes them', async () => {
    const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff);
    const result = await readResponse(
      new Response(png, { headers: { 'content-type': 'image/png' } }),
      performance.now(),
    );
    expect(result.binary).toBe(true);
    expect(result.body).toBe('');
    expect(Array.from(result.bytes!)).toEqual(Array.from(png));
    expect(result.sizeBytes).toBe(png.length);
  });

  it('keeps text bodies as text and keeps the original bytes too', async () => {
    const source = text('{"ok":true}');
    const result = await readResponse(
      new Response(source, { headers: { 'content-type': 'application/json' } }),
      performance.now(),
    );
    expect(result.binary).toBeUndefined();
    expect(result.body).toBe('{"ok":true}');
    expect(Array.from(result.bytes!)).toEqual(Array.from(source));
  });

  it('reports each event of an SSE response as it arrives, then resolves when it closes', async () => {
    const { body } = streamOf(['id: 1\ndata: one\n\n', 'event: done\ndata: two\n\n']);
    const onStreamStart = vi.fn();
    const batches: SseEvent[][] = [];
    const result = await readResponse(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      performance.now(),
      0,
      { onStreamStart, onStreamEvents: (events) => batches.push(events) },
    );
    expect(onStreamStart).toHaveBeenCalledOnce();
    expect(batches.flat().map((item) => item.data)).toEqual(['one', 'two']);
    expect(result.stream).toMatchObject({ ended: 'closed', dropped: 0 });
    expect(result.stream!.events).toHaveLength(2);
    expect(result.body).toContain('data: two');
  });

  it('keeps the events received when an open stream is aborted', async () => {
    const { body, controller } = streamOf(['data: first\n\n'], true);
    const seen: string[] = [];
    const pending = readResponse(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      performance.now(),
      0,
      {
        onStreamEvents: (events) => {
          seen.push(...events.map((item) => item.data));
          // The user presses Stop: the connection is aborted while the stream is still open.
          controller().error(new DOMException('aborted', 'AbortError'));
        },
      },
    );
    const result = await pending;
    expect(seen).toEqual(['first']);
    expect(result.stream).toMatchObject({ ended: 'stopped' });
    expect(result.stream!.events.map((item) => item.data)).toEqual(['first']);
  });

  it('reads an SSE response as a plain body when no stream hooks are given', async () => {
    const { body } = streamOf(['data: x\n\n']);
    const result = await readResponse(
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      performance.now(),
    );
    expect(result.stream).toBeUndefined();
    expect(result.body).toBe('data: x\n\n');
  });
});

describe('buildStreamResponse', () => {
  it('builds a stopped stream from the events received', () => {
    const events: SseEvent[] = [{ index: 1, data: 'a', receivedAt: 5 }];
    const built = buildStreamResponse(
      { status: 200, statusText: 'OK', headers: {}, contentType: 'text/event-stream' },
      events,
      1200,
      'stopped',
    );
    expect(built.stream).toEqual({ events, ended: 'stopped', dropped: 0 });
    expect(built.body).toBe('data: a\n\n');
    expect(built.sizeBytes).toBe(9);
  });
});
