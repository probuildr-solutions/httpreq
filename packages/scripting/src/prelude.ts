/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * The script API, written in JavaScript and evaluated inside the sandbox before a user's script.
 *
 * The sandbox has no host functions at all, so everything here is plain JavaScript over the data
 * the host passed in as JSON (`__input`); what the script produced is read back as a JSON string
 * (`__output`). There is no network, file, timer, module or `eval`-of-host access to expose
 * because none exists inside the interpreter. New APIs are added here (or in a further prelude
 * module) without any change to the host.
 *
 * It must stay free of backticks and `${`: it is embedded as a raw template string.
 */
export const SCRIPT_PRELUDE = String.raw`
(function (global) {
    'use strict';
    var input = JSON.parse(global.__input);
    delete global.__input;

    var logs = [];
    var tests = [];
    var MAX_LOGS = 500;
    var MAX_TEXT = 4000;

    function show(value) {
        if (typeof value === 'string') return JSON.stringify(value);
        if (typeof value === 'function') return '[Function]';
        try {
            var text = JSON.stringify(value);
            return text === undefined ? String(value) : text;
        } catch (error) {
            return String(value);
        }
    }

    function format(args) {
        var text = Array.prototype.map
            .call(args, function (item) {
                return typeof item === 'string' ? item : show(item);
            })
            .join(' ');
        return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
    }

    function logger(level) {
        return function () {
            if (logs.length < MAX_LOGS) logs.push({ level: level, message: format(arguments) });
        };
    }
    var consoleApi = {
        log: logger('log'),
        info: logger('info'),
        warn: logger('warn'),
        error: logger('error'),
        debug: logger('log')
    };

    /* ---------- key/value stores ---------- */

    function store(initial) {
        var data = Object.create(null);
        Object.keys(initial || {}).forEach(function (key) { data[key] = String(initial[key]); });
        return {
            data: data,
            api: {
                get: function (key) { return key in data ? data[key] : undefined; },
                has: function (key) { return key in data; },
                set: function (key, value) {
                    if (typeof key !== 'string' || !key) throw new TypeError('The name must be a non-empty string.');
                    data[key] = value === undefined || value === null ? '' : String(value);
                },
                unset: function (key) { delete data[key]; },
                toObject: function () {
                    var copy = {};
                    Object.keys(data).forEach(function (key) { copy[key] = data[key]; });
                    return copy;
                }
            }
        };
    }
    var environment = store(input.environment);
    var variables = store(input.variables);

    /* ---------- headers (case-insensitive, keeps the written casing) ---------- */

    function headerStore(initial) {
        var entries = Object.create(null);
        Object.keys(initial || {}).forEach(function (name) {
            entries[name.toLowerCase()] = { name: name, value: String(initial[name]) };
        });
        return {
            entries: entries,
            api: {
                get: function (name) {
                    var entry = entries[String(name).toLowerCase()];
                    return entry ? entry.value : undefined;
                },
                has: function (name) { return String(name).toLowerCase() in entries; },
                set: function (name, value) {
                    name = String(name);
                    if (!/^[A-Za-z0-9!#$%&'*+.^_|~-]+$/.test(name)) {
                        throw new TypeError('"' + name + '" is not a valid header name.');
                    }
                    value = String(value);
                    if (/[\r\n]/.test(value)) throw new TypeError('A header value cannot contain line breaks.');
                    entries[name.toLowerCase()] = { name: name, value: value };
                },
                remove: function (name) { delete entries[String(name).toLowerCase()]; },
                toObject: function () {
                    var copy = {};
                    Object.keys(entries).forEach(function (key) { copy[entries[key].name] = entries[key].value; });
                    return copy;
                }
            }
        };
    }

    var requestHeaders = headerStore(input.request.headers);
    var request = {
        method: input.request.method,
        url: input.request.url,
        body: input.request.body,
        headers: requestHeaders.api
    };

    var response;
    if (input.response) {
        var responseHeaders = headerStore(input.response.headers);
        var parsed;
        response = {
            status: input.response.status,
            code: input.response.status,
            statusText: input.response.statusText,
            headers: responseHeaders.api,
            responseTime: input.response.durationMs,
            size: input.response.sizeBytes,
            text: function () { return input.response.body; },
            json: function () {
                if (parsed === undefined) parsed = { value: JSON.parse(input.response.body) };
                return parsed.value;
            }
        };
    }

    /* ---------- assertions ---------- */

    function AssertionError(message) {
        this.name = 'AssertionError';
        this.message = message;
    }
    AssertionError.prototype = Object.create(Error.prototype);
    AssertionError.prototype.constructor = AssertionError;

    function typeOf(value) {
        if (value === null) return 'null';
        if (Array.isArray(value)) return 'array';
        return typeof value;
    }

    function deepEqual(a, b) {
        if (a === b) return true;
        if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
            return a !== a && b !== b;
        }
        if (Array.isArray(a) !== Array.isArray(b)) return false;
        var keysA = Object.keys(a);
        var keysB = Object.keys(b);
        if (keysA.length !== keysB.length) return false;
        return keysA.every(function (key) {
            return Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]);
        });
    }

    function Assertion(actual, negate, deep) {
        this.actual = actual;
        this.negate = !!negate;
        this.deepFlag = !!deep;
    }
    ['to', 'be', 'been', 'is', 'that', 'which', 'and', 'has', 'have', 'with', 'at', 'of', 'same', 'does', 'still']
        .forEach(function (word) {
            Object.defineProperty(Assertion.prototype, word, { get: function () { return this; } });
        });
    Object.defineProperty(Assertion.prototype, 'not', {
        get: function () { return new Assertion(this.actual, !this.negate, this.deepFlag); }
    });
    Object.defineProperty(Assertion.prototype, 'deep', {
        get: function () { return new Assertion(this.actual, this.negate, true); }
    });

    function check(self, condition, message, negated) {
        if (!!condition === self.negate) throw new AssertionError(self.negate ? negated : message);
    }

    function flag(name, test, message, negated) {
        Object.defineProperty(Assertion.prototype, name, {
            get: function () {
                check(this, test(this.actual), 'expected ' + show(this.actual) + ' to ' + message,
                    'expected ' + show(this.actual) + ' not to ' + negated);
                return this;
            }
        });
    }
    flag('ok', function (v) { return !!v; }, 'be truthy', 'be truthy');
    flag('true', function (v) { return v === true; }, 'be true', 'be true');
    flag('false', function (v) { return v === false; }, 'be false', 'be false');
    flag('null', function (v) { return v === null; }, 'be null', 'be null');
    flag('undefined', function (v) { return v === undefined; }, 'be undefined', 'be undefined');
    flag('exist', function (v) { return v !== null && v !== undefined; }, 'exist', 'exist');
    flag('empty', function (v) {
        if (typeof v === 'string' || Array.isArray(v)) return v.length === 0;
        return v && typeof v === 'object' ? Object.keys(v).length === 0 : false;
    }, 'be empty', 'be empty');

    function method(names, body) {
        names.forEach(function (name) {
            Assertion.prototype[name] = function () {
                body.apply(this, arguments);
                return this;
            };
        });
    }
    method(['equal', 'equals', 'eq'], function (expected) {
        var same = this.deepFlag ? deepEqual(this.actual, expected) : this.actual === expected;
        check(this, same, 'expected ' + show(this.actual) + ' to equal ' + show(expected),
            'expected ' + show(this.actual) + ' not to equal ' + show(expected));
    });
    method(['eql'], function (expected) {
        check(this, deepEqual(this.actual, expected),
            'expected ' + show(this.actual) + ' to deeply equal ' + show(expected),
            'expected ' + show(this.actual) + ' not to deeply equal ' + show(expected));
    });
    method(['a', 'an'], function (type) {
        check(this, typeOf(this.actual) === type,
            'expected ' + show(this.actual) + ' to be a ' + type,
            'expected ' + show(this.actual) + ' not to be a ' + type);
    });
    method(['include', 'includes', 'contain', 'contains'], function (item) {
        var actual = this.actual;
        var found = typeof actual === 'string' ? actual.indexOf(item) !== -1
            : Array.isArray(actual) ? actual.some(function (entry) { return deepEqual(entry, item); })
            : actual && typeof actual === 'object' ? Object.keys(item || {}).every(function (key) { return deepEqual(actual[key], item[key]); })
            : false;
        check(this, found, 'expected ' + show(actual) + ' to include ' + show(item),
            'expected ' + show(actual) + ' not to include ' + show(item));
    });
    method(['property'], function (name, value) {
        var actual = this.actual;
        var has = actual !== null && actual !== undefined && Object.prototype.hasOwnProperty.call(Object(actual), name);
        var matches = arguments.length < 2 || deepEqual(actual && actual[name], value);
        check(this, has && matches,
            'expected ' + show(actual) + ' to have property ' + show(name) + (arguments.length > 1 ? ' of ' + show(value) : ''),
            'expected ' + show(actual) + ' not to have property ' + show(name));
    });
    method(['above', 'gt', 'greaterThan'], function (n) {
        check(this, this.actual > n, 'expected ' + show(this.actual) + ' to be above ' + n, 'expected ' + show(this.actual) + ' not to be above ' + n);
    });
    method(['below', 'lt', 'lessThan'], function (n) {
        check(this, this.actual < n, 'expected ' + show(this.actual) + ' to be below ' + n, 'expected ' + show(this.actual) + ' not to be below ' + n);
    });
    method(['least', 'gte'], function (n) {
        check(this, this.actual >= n, 'expected ' + show(this.actual) + ' to be at least ' + n, 'expected ' + show(this.actual) + ' to be below ' + n);
    });
    method(['most', 'lte'], function (n) {
        check(this, this.actual <= n, 'expected ' + show(this.actual) + ' to be at most ' + n, 'expected ' + show(this.actual) + ' to be above ' + n);
    });
    method(['within'], function (low, high) {
        check(this, this.actual >= low && this.actual <= high,
            'expected ' + show(this.actual) + ' to be within ' + low + '..' + high,
            'expected ' + show(this.actual) + ' not to be within ' + low + '..' + high);
    });
    method(['lengthOf', 'length'], function (n) {
        var length = this.actual === null || this.actual === undefined ? undefined : this.actual.length;
        check(this, length === n, 'expected ' + show(this.actual) + ' to have length ' + n + ' but got ' + length,
            'expected ' + show(this.actual) + ' not to have length ' + n);
    });
    method(['match', 'matches'], function (pattern) {
        check(this, typeof this.actual === 'string' && pattern.test(this.actual),
            'expected ' + show(this.actual) + ' to match ' + String(pattern),
            'expected ' + show(this.actual) + ' not to match ' + String(pattern));
    });
    method(['oneOf'], function (list) {
        check(this, list.some(function (entry) { return deepEqual(entry, this.actual); }, this),
            'expected ' + show(this.actual) + ' to be one of ' + show(list),
            'expected ' + show(this.actual) + ' not to be one of ' + show(list));
    });
    method(['status'], function (code) {
        var actual = this.actual && this.actual.status;
        check(this, actual === code, 'expected status ' + actual + ' to be ' + code, 'expected status not to be ' + code);
    });

    function expect(actual) { return new Assertion(actual); }

    function test(name, fn) {
        if (typeof fn !== 'function') throw new TypeError('test(name, fn) needs a function.');
        try {
            fn();
            tests.push({ name: String(name), passed: true });
        } catch (error) {
            tests.push({
                name: String(name),
                passed: false,
                error: error && error.message ? String(error.message) : String(error)
            });
        }
    }

    /* ---------- utilities (no host access: pure functions) ---------- */

    var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

    function utf8Bytes(text) {
        var encoded = unescape(encodeURIComponent(String(text)));
        var bytes = [];
        for (var i = 0; i < encoded.length; i += 1) bytes.push(encoded.charCodeAt(i));
        return bytes;
    }
    function bytesToText(bytes) {
        var text = '';
        for (var i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
        return decodeURIComponent(escape(text));
    }
    function base64Encode(text) {
        var bytes = utf8Bytes(text);
        var out = '';
        for (var i = 0; i < bytes.length; i += 3) {
            var chunk = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
            out += B64[(chunk >> 18) & 63] + B64[(chunk >> 12) & 63] +
                (i + 1 < bytes.length ? B64[(chunk >> 6) & 63] : '=') +
                (i + 2 < bytes.length ? B64[chunk & 63] : '=');
        }
        return out;
    }
    function base64Decode(text) {
        var clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
        var bytes = [];
        for (var i = 0; i < clean.length; i += 4) {
            var a = B64.indexOf(clean[i]), b = B64.indexOf(clean[i + 1]);
            var c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]) : -1;
            var d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]) : -1;
            bytes.push(((a << 2) | (b >> 4)) & 255);
            if (c >= 0) bytes.push(((b << 4) | (c >> 2)) & 255);
            if (d >= 0) bytes.push(((c << 6) | d) & 255);
        }
        return bytesToText(bytes);
    }

    var K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    function sha256Bytes(bytes) {
        var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        var data = bytes.slice();
        var bitLength = data.length * 8;
        data.push(0x80);
        while (data.length % 64 !== 56) data.push(0);
        for (var s = 7; s >= 0; s -= 1) data.push(s >= 4 ? 0 : (bitLength >>> (s * 8)) & 255);
        for (var offset = 0; offset < data.length; offset += 64) {
            var w = [];
            for (var t = 0; t < 16; t += 1) {
                w[t] = (data[offset + t * 4] << 24) | (data[offset + t * 4 + 1] << 16) |
                    (data[offset + t * 4 + 2] << 8) | data[offset + t * 4 + 3];
            }
            for (var u = 16; u < 64; u += 1) {
                var s0 = rotr(w[u - 15], 7) ^ rotr(w[u - 15], 18) ^ (w[u - 15] >>> 3);
                var s1 = rotr(w[u - 2], 17) ^ rotr(w[u - 2], 19) ^ (w[u - 2] >>> 10);
                w[u] = (w[u - 16] + s0 + w[u - 7] + s1) | 0;
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
            for (var r = 0; r < 64; r += 1) {
                var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
                var ch = (e & f) ^ (~e & g);
                var temp1 = (hh + S1 + ch + K[r] + w[r]) | 0;
                var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
                var maj = (a & b) ^ (a & c) ^ (b & c);
                var temp2 = (S0 + maj) | 0;
                hh = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
            }
            h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
            h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
        }
        var out = [];
        h.forEach(function (word) {
            out.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
        });
        return out;
    }
    function toHex(bytes) {
        return bytes.map(function (byte) { return ('0' + byte.toString(16)).slice(-2); }).join('');
    }
    function hmacSha256Bytes(key, message) {
        var keyBytes = utf8Bytes(key);
        if (keyBytes.length > 64) keyBytes = sha256Bytes(keyBytes);
        while (keyBytes.length < 64) keyBytes.push(0);
        var inner = keyBytes.map(function (byte) { return byte ^ 0x36; }).concat(utf8Bytes(message));
        var outer = keyBytes.map(function (byte) { return byte ^ 0x5c; }).concat(sha256Bytes(inner));
        return sha256Bytes(outer);
    }

    var utils = {
        base64Encode: base64Encode,
        base64Decode: base64Decode,
        sha256Hex: function (text) { return toHex(sha256Bytes(utf8Bytes(text))); },
        hmacSha256Hex: function (key, text) { return toHex(hmacSha256Bytes(key, text)); },
        hmacSha256Base64: function (key, text) {
            return base64Encode(bytesToText(hmacSha256Bytes(key, text)));
        },
        uuid: function () {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = (Math.random() * 16) | 0;
                return (c === 'x' ? r : (r & 3) | 8).toString(16);
            });
        },
        timestamp: function () { return Date.now(); },
        isoTimestamp: function () { return new Date().toISOString(); },
        randomInt: function (min, max) { return min + Math.floor(Math.random() * (max - min + 1)); },
        urlEncode: function (text) { return encodeURIComponent(text); },
        urlDecode: function (text) { return decodeURIComponent(text); }
    };

    /* ---------- the public surface ---------- */

    var httpreq = {
        info: { stage: input.stage },
        request: request,
        environment: environment.api,
        variables: variables.api,
        test: test,
        expect: expect,
        utils: utils
    };
    if (response) httpreq.response = response;
    Object.freeze(httpreq.utils);

    Object.defineProperty(global, 'httpreq', { value: httpreq, enumerable: true });
    Object.defineProperty(global, 'console', { value: consoleApi, enumerable: true });
    Object.defineProperty(global, 'expect', { value: expect, enumerable: true });
    Object.defineProperty(global, 'test', { value: test, enumerable: true });
    global.btoa = base64Encode;
    global.atob = base64Decode;

    global.__finish = function () {
        return JSON.stringify({
            request: {
                method: String(request.method),
                url: String(request.url),
                headers: requestHeaders.api.toObject(),
                body: request.body === null || request.body === undefined ? null : String(request.body)
            },
            environment: environment.api.toObject(),
            variables: variables.api.toObject(),
            tests: tests,
            logs: logs
        });
    };
})(globalThis);
`;
