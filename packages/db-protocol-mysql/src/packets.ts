/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { DbError } from '@httpreq/db-core';

/** One packet of the MySQL protocol, with its sequence number. */
export interface Packet {
    sequence: number;
    payload: Buffer;
}

const MAX_PAYLOAD = 0xff_ffff;
/** The largest packet this client accepts from a server, whatever it claims to send. */
const MAX_ACCEPTED_BYTES = 1024 * 1024 * 1024;

/**
 * Splits the byte stream from the server into packets. Each packet starts with a three-byte
 * length and a one-byte sequence number; a payload of exactly 16 MiB − 1 continues in the next
 * packet, and such continuations are joined here, so callers always see whole payloads.
 */
export class PacketReader {
    private chunks: Buffer[] = [];
    private buffered = 0;
    private continued: Buffer[] = [];
    private continuedBytes = 0;

    /** Adds bytes from the socket and returns every packet they complete. */
    push(chunk: Buffer): Packet[] {
        this.chunks.push(chunk);
        this.buffered += chunk.length;
        const out: Packet[] = [];
        for (;;) {
            if (this.buffered < 4) break;
            const header = this.peek(4);
            const length = header.readUIntLE(0, 3);
            if (this.buffered < 4 + length) break;
            const sequence = header[3]!;
            this.take(4);
            const payload = length === 0 ? Buffer.alloc(0) : this.take(length);
            if (length === MAX_PAYLOAD) {
                this.continued.push(payload);
                this.continuedBytes += payload.length;
                if (this.continuedBytes > MAX_ACCEPTED_BYTES) {
                    throw new DbError('LIMIT_EXCEEDED', 'The server sent an oversized packet.');
                }
                continue;
            }
            if (this.continued.length > 0) {
                this.continued.push(payload);
                out.push({ sequence, payload: Buffer.concat(this.continued) });
                this.continued = [];
                this.continuedBytes = 0;
            } else {
                out.push({ sequence, payload });
            }
        }
        return out;
    }

    private peek(length: number): Buffer {
        if (this.chunks[0]!.length >= length) return this.chunks[0]!.subarray(0, length);
        return Buffer.concat(this.chunks).subarray(0, length);
    }

    private take(length: number): Buffer {
        this.buffered -= length;
        const first = this.chunks[0]!;
        if (first.length >= length) {
            if (first.length === length) this.chunks.shift();
            else this.chunks[0] = first.subarray(length);
            return first.subarray(0, length);
        }
        const all = Buffer.concat(this.chunks);
        this.chunks = all.length > length ? [all.subarray(length)] : [];
        return all.subarray(0, length);
    }
}

/** Frames a payload into packets, splitting at 16 MiB − 1 as the protocol requires. */
export const framePacket = (
    payload: Buffer,
    firstSequence: number,
): { frame: Buffer; next: number } => {
    const frames: Buffer[] = [];
    let sequence = firstSequence;
    let offset = 0;
    for (;;) {
        const length = Math.min(MAX_PAYLOAD, payload.length - offset);
        const header = Buffer.alloc(4);
        header.writeUIntLE(length, 0, 3);
        header[3] = sequence & 0xff;
        frames.push(header, payload.subarray(offset, offset + length));
        offset += length;
        sequence++;
        // A payload that is an exact multiple of the maximum ends with an empty packet.
        if (length < MAX_PAYLOAD) break;
    }
    return { frame: Buffer.concat(frames), next: sequence };
};

/** A cursor over one payload, reading the protocol's primitive types. */
export class PayloadReader {
    offset = 0;

    constructor(readonly buffer: Buffer) {}

    get remaining(): number {
        return this.buffer.length - this.offset;
    }

    u8(): number {
        return this.buffer[this.offset++]!;
    }

    u16(): number {
        const value = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        return value;
    }

    u24(): number {
        const value = this.buffer.readUIntLE(this.offset, 3);
        this.offset += 3;
        return value;
    }

    u32(): number {
        const value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        return value;
    }

    skip(length: number): void {
        this.offset += length;
    }

    bytes(length: number): Buffer {
        const value = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        return value;
    }

    /** A string ending at the next zero byte. */
    nullTerminated(): string {
        const end = this.buffer.indexOf(0, this.offset);
        const stop = end === -1 ? this.buffer.length : end;
        const text = this.buffer.toString('utf8', this.offset, stop);
        this.offset = Math.min(this.buffer.length, stop + 1);
        return text;
    }

    /** The rest of the payload as text. */
    rest(): string {
        const text = this.buffer.toString('utf8', this.offset);
        this.offset = this.buffer.length;
        return text;
    }

    /**
     * A length-encoded integer. Values above 2^53 cannot be held exactly in a number; they come
     * back as a bigint, and callers that need a count treat that as out of range.
     */
    lenEnc(): number | bigint | null {
        const first = this.u8();
        if (first < 0xfb) return first;
        if (first === 0xfb) return null; // NULL in a row
        if (first === 0xfc) return this.u16();
        if (first === 0xfd) return this.u24();
        const value = this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
    }

    /** A length-encoded integer that must be a plain number. */
    lenEncNumber(): number {
        const value = this.lenEnc();
        if (typeof value !== 'number')
            throw new DbError('INTERNAL', 'The server sent an unexpected length.');
        return value;
    }

    /** A length-encoded byte string; `null` for the NULL marker. */
    lenEncBytes(): Buffer | null {
        const length = this.lenEnc();
        if (length === null) return null;
        if (typeof length !== 'number' || length > this.remaining) {
            throw new DbError('INTERNAL', 'The server sent a malformed row.');
        }
        return this.bytes(length);
    }

    lenEncString(): string | null {
        return this.lenEncBytes()?.toString('utf8') ?? null;
    }
}

/** Writes a length-encoded integer. */
export const writeLenEnc = (value: number): Buffer => {
    if (value < 0xfb) return Buffer.from([value]);
    if (value <= 0xffff) {
        const out = Buffer.alloc(3);
        out[0] = 0xfc;
        out.writeUInt16LE(value, 1);
        return out;
    }
    if (value <= 0xff_ffff) {
        const out = Buffer.alloc(4);
        out[0] = 0xfd;
        out.writeUIntLE(value, 1, 3);
        return out;
    }
    const out = Buffer.alloc(9);
    out[0] = 0xfe;
    out.writeBigUInt64LE(BigInt(value), 1);
    return out;
};
