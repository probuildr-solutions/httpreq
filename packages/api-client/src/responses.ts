import type { HttpResponse, SseEvent } from '@httpreq/shared';

/**
 * Response classification shared by the transport (which decides whether a body may be decoded
 * as text) and the UI (which decides how to show it and what to call a saved copy).
 */

/** A response header, looked up case-insensitively. */
export const headerOf = (headers: Record<string, string>, name: string): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

/** The media type of a `Content-Type` value: lower-case, without parameters. */
export const mimeTypeOf = (contentType: string) =>
  (contentType.split(';')[0] ?? '').trim().toLowerCase();

export const isEventStream = (contentType: string) =>
  mimeTypeOf(contentType) === 'text/event-stream';

export interface ContentDisposition {
  type: 'attachment' | 'inline' | null;
  fileName: string | null;
}

/** Strips any directory part and characters that are not allowed in file names. */
export const safeFileName = (name: string) => {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = [...base]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"|?*'.includes(char) ? '_' : char))
    .join('')
    .trim()
    .replace(/^\.+/, '');
  return cleaned.slice(0, 200);
};

const decodeExtValue = (value: string) => {
  // RFC 5987: charset'language'percent-encoded-bytes
  const match = /^([^']*)'[^']*'(.*)$/.exec(value);
  if (!match) return null;
  const bytes: number[] = [];
  const encoded = match[2]!;
  for (let i = 0; i < encoded.length; i += 1) {
    const hex = encoded[i] === '%' ? encoded.slice(i + 1, i + 3) : '';
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(encoded.charCodeAt(i) & 0xff);
  }
  try {
    return new TextDecoder(match[1] || 'utf-8').decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
};

/** Parses a `Content-Disposition` value, including the RFC 5987 `filename*=` form. */
export const parseContentDisposition = (value: string | undefined): ContentDisposition => {
  if (!value) return { type: null, fileName: null };
  const [first = '', ...params] = value.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  const type = first.trim().toLowerCase();
  let plain: string | null = null;
  let extended: string | null = null;
  for (const param of params) {
    const separator = param.indexOf('=');
    if (separator < 0) continue;
    const name = param.slice(0, separator).trim().toLowerCase();
    let text = param.slice(separator + 1).trim();
    if (name === 'filename*') extended = decodeExtValue(text.replace(/^"|"$/g, ''));
    else if (name === 'filename') {
      if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
        text = text.slice(1, -1).replace(/\\(.)/g, '$1');
      }
      plain = text;
    }
  }
  const fileName = safeFileName(extended ?? plain ?? '') || null;
  return {
    type: type === 'attachment' ? 'attachment' : type === 'inline' ? 'inline' : null,
    fileName,
  };
};

const TEXT_LIKE =
  /^(text\/|application\/(json|xml|javascript|ecmascript|x-javascript|x-www-form-urlencoded|yaml|x-yaml|graphql|sql|x-sh|toml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|x-ndjson|ndjson)|image\/svg\+xml)/;

const BINARY_TYPE =
  /^(image\/(?!svg)|audio\/|video\/|font\/|application\/(pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|x-bzip2|zstd|wasm|msword|rtf|x-msdownload|vnd\.(?!.*\+(json|xml))))/;

/** Whether a media type is text that can be shown as is. */
export const isTextMimeType = (mime: string) =>
  TEXT_LIKE.test(mime) || /\+(json|xml|yaml)$/.test(mime);

/** Whether a media type is certainly not text (so decoding it would only make garbage). */
export const isBinaryMimeType = (mime: string) => !isTextMimeType(mime) && BINARY_TYPE.test(mime);

/** Bytes that are not valid UTF-8, or that contain NUL, are not text. */
const looksBinary = (bytes: Uint8Array) => {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return false;
  } catch {
    // A multi-byte character cut by the end of the sample is not evidence of binary data.
    if (bytes.length <= sample.length) return true;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, sample.length - 3));
      return false;
    } catch {
      return true;
    }
  }
};

/**
 * Whether a body must not be decoded as text. Text-like types never are; known binary types
 * always are; anything else (no type, `application/octet-stream`, unknown types) is decided from
 * the bytes themselves.
 */
export const isBinaryBody = (bytes: Uint8Array, contentType: string) => {
  const mime = mimeTypeOf(contentType);
  if (isTextMimeType(mime)) return false;
  if (isBinaryMimeType(mime)) return true;
  return looksBinary(bytes);
};

/** Decodes with the response's declared charset, falling back to UTF-8. */
export const decodeBody = (bytes: Uint8Array, contentType: string) => {
  const charset = /charset\s*=\s*"?([^\s;"]+)/i.exec(contentType)?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
};

const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/css': 'css',
  'text/markdown': 'md',
  'text/event-stream': 'txt',
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/octet-stream': 'bin',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export const extensionFor = (mime: string, binary: boolean) => {
  const known = EXTENSIONS[mime];
  if (known) return known;
  if (/\+json$/.test(mime)) return 'json';
  if (/\+xml$/.test(mime)) return 'xml';
  return binary ? 'bin' : 'txt';
};

export interface ResponseInfo {
  /** Media type without parameters, e.g. `application/pdf`. */
  mimeType: string;
  disposition: ContentDisposition['type'];
  /** The file name the server suggested, when it did. */
  fileName: string | null;
  /** `Content-Length` as sent, when available. */
  contentLength: number | null;
  sizeBytes: number;
  binary: boolean;
  /** The server marked the body as a download (`Content-Disposition`), or it is binary. */
  isDownload: boolean;
  isStream: boolean;
}

export const describeResponse = (response: HttpResponse): ResponseInfo => {
  const disposition = parseContentDisposition(headerOf(response.headers, 'content-disposition'));
  const length = Number(headerOf(response.headers, 'content-length'));
  const binary = !!response.binary;
  return {
    mimeType: mimeTypeOf(response.contentType),
    disposition: disposition.type,
    fileName: disposition.fileName,
    contentLength: Number.isFinite(length) && length >= 0 ? length : null,
    sizeBytes: response.sizeBytes,
    binary,
    isDownload: disposition.type === 'attachment' || binary,
    isStream: !!response.stream,
  };
};

/** The name a saved copy gets: the server's suggestion, else one made from the content type. */
export const suggestedFileName = (response: HttpResponse) => {
  const info = describeResponse(response);
  if (info.fileName) return info.fileName;
  return `response.${extensionFor(info.mimeType, info.binary)}`;
};

/** The bytes to save: exactly what was received, or the text re-encoded when none were kept. */
export const responseBytes = (response: HttpResponse): Uint8Array =>
  response.bytes ?? new TextEncoder().encode(response.body);

/* ---------- Server-Sent Events ---------- */

export interface SseParser {
  /** Feeds decoded text; returns the events completed by it. */
  push(text: string, receivedAt: number): SseEvent[];
  /** Ends the stream; an event that was cut off by the end is returned if it has data. */
  flush(receivedAt: number): SseEvent[];
}

/** Incremental parser for the `text/event-stream` format (WHATWG HTML §9.2). */
export const createSseParser = (): SseParser => {
  let buffer = '';
  let index = 0;
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  const dispatch = (receivedAt: number): SseEvent | null => {
    const complete =
      data.length > 0
        ? ({
            index: ++index,
            ...(event ? { event } : {}),
            data: data.join('\n'),
            ...(id !== undefined ? { id } : {}),
            ...(retry !== undefined ? { retry } : {}),
            receivedAt,
          } satisfies SseEvent)
        : null;
    data = [];
    event = undefined;
    id = undefined;
    retry = undefined;
    return complete;
  };

  const handleLine = (line: string, receivedAt: number): SseEvent | null => {
    if (line === '') return dispatch(receivedAt);
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') {
      if (!value.includes('\0')) id = value;
    } else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    return null;
  };

  return {
    push(text, receivedAt) {
      buffer += text;
      const events: SseEvent[] = [];
      for (;;) {
        const match = /\r\n|\n|\r/.exec(buffer);
        if (!match) break;
        // A lone CR at the very end may be the first half of CRLF: wait for the next chunk.
        if (match[0] === '\r' && match.index === buffer.length - 1) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const complete = handleLine(line, receivedAt);
        if (complete) events.push(complete);
      }
      return events;
    },
    flush(receivedAt) {
      const events: SseEvent[] = [];
      if (buffer) {
        const complete = handleLine(buffer.replace(/\r$/, ''), receivedAt);
        if (complete) events.push(complete);
        buffer = '';
      }
      const last = dispatch(receivedAt);
      if (last) events.push(last);
      return events;
    },
  };
};

/** Events written back in the `text/event-stream` format (for the Raw view and saved copies). */
export const serializeSseEvents = (events: readonly SseEvent[]) =>
  events
    .map((item) =>
      [
        item.event ? `event: ${item.event}` : null,
        item.id !== undefined ? `id: ${item.id}` : null,
        item.retry !== undefined ? `retry: ${item.retry}` : null,
        ...item.data.split('\n').map((line) => `data: ${line}`),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    )
    .map((block) => `${block}\n\n`)
    .join('');
