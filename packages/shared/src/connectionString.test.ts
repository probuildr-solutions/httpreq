/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    formatConnectionString,
    parseConnectionString,
    redactConnectionString,
    type ParsedConnection,
} from './connectionString';

const ok = (text: string, engine?: Parameters<typeof parseConnectionString>[1]) => {
    const result = parseConnectionString(text, engine);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result.value;
};
const error = (text: string, engine?: Parameters<typeof parseConnectionString>[1]) => {
    const result = parseConnectionString(text, engine);
    if (result.ok) throw new Error('expected an error');
    return result.error;
};

describe('MySQL', () => {
    it('reads the parts of a URL', () => {
        expect(ok('mysql://app:s3cret@db.example.com:3307/shop')).toMatchObject({
            engine: 'mysql',
            host: 'db.example.com',
            port: 3307,
            database: 'shop',
            username: 'app',
            password: 's3cret',
        });
    });

    it('defaults the port, decodes escapes and reads SSL and timeout parameters', () => {
        const value = ok(
            'mysql://us%40er:p%3Ass%2Fw@h/db?ssl-mode=VERIFY_IDENTITY&connectTimeout=5000&charset=utf8mb4',
        );
        expect(value).toMatchObject({
            port: 3306,
            username: 'us@er',
            password: 'p:ss/w',
            tls: 'verify-full',
            connectTimeoutMs: 5000,
            options: { charset: 'utf8mb4' },
        });
    });

    it('reports an unknown ssl-mode instead of ignoring it', () => {
        expect(error('mysql://h/db?ssl-mode=BOGUS').code).toBe('PARAMETER');
    });
});

describe('PostgreSQL', () => {
    it('reads sslmode, search path and the application name', () => {
        const value = ok(
            'postgresql://u:p@pg.example.com:5433/app?sslmode=verify-ca&options=-c%20search_path%3Dsales,public&application_name=httpreq&connect_timeout=7',
        );
        expect(value).toMatchObject({
            engine: 'postgresql',
            port: 5433,
            tls: 'verify-ca',
            connectTimeoutMs: 7000,
            options: { searchPath: 'sales,public', application_name: 'httpreq' },
        });
    });

    it('accepts the postgres:// alias and IPv6 hosts', () => {
        expect(ok('postgres://u@[::1]:5432/d')).toMatchObject({ host: '::1', port: 5432 });
    });

    it('treats sslmode=allow as prefer', () => {
        expect(ok('postgresql://h/d?sslmode=allow').tls).toBe('prefer');
    });
});

describe('MongoDB', () => {
    it('reads hosts, replica set, auth source and the driver options', () => {
        const value = ok(
            'mongodb://root:pw@a.example.com:27017,b.example.com:27018/orders?replicaSet=rs0&authSource=admin&readPreference=secondaryPreferred&w=majority&retryWrites=true&tls=true',
        );
        expect(value).toMatchObject({
            host: 'a.example.com',
            port: 27017,
            database: 'orders',
            tls: 'verify-full',
            options: {
                seeds: 'b.example.com:27018',
                replicaSet: 'rs0',
                authSource: 'admin',
                readPreference: 'secondaryPreferred',
                w: 'majority',
                retryWrites: 'true',
            },
        });
    });

    it('keeps mongodb+srv as a cluster name for the driver to resolve, with TLS on', () => {
        const value = ok(
            'mongodb+srv://user:pa%24s@cluster0.ab1cd.mongodb.net/test?retryWrites=true&w=majority',
        );
        expect(value.host).toBe('cluster0.ab1cd.mongodb.net');
        expect(value.options.srv).toBe('true');
        expect(value.tls).toBe('verify-full');
        expect(value.password).toBe('pa$s');
    });

    it('rejects a port or several hosts on an SRV string, as the driver does', () => {
        expect(error('mongodb+srv://c.example.net:27017/db').code).toBe('SRV');
        expect(error('mongodb+srv://a.example.net,b.example.net/db').code).toBe('SRV');
        expect(error('mongodb+srv://localhost/db').code).toBe('SRV');
    });

    it('maps the TLS validation switches', () => {
        expect(ok('mongodb://h/?tls=true&tlsAllowInvalidCertificates=true').tls).toBe('require');
        expect(ok('mongodb://h/?tls=true&tlsAllowInvalidHostnames=true').tls).toBe('verify-ca');
        expect(ok('mongodb://h/?tls=false').tls).toBe('disable');
    });
});

describe('Redis', () => {
    it('reads the database index, and rediss:// means TLS', () => {
        expect(ok('rediss://default:pw@cache.example.com:6380/2')).toMatchObject({
            engine: 'redis',
            port: 6380,
            database: '2',
            tls: 'verify-full',
        });
    });
});

describe('errors', () => {
    it('explains an empty string, a missing scheme and an unknown one', () => {
        expect(error('').code).toBe('EMPTY');
        expect(error('db.example.com:3306').code).toBe('SCHEME');
        expect(error('ftp://h/').code).toBe('SCHEME');
    });

    it('reports a string for another engine than the form is set to', () => {
        expect(error('mongodb://h/', 'mysql').code).toBe('ENGINE_MISMATCH');
    });

    it('reports a bad port, bad escape and empty host', () => {
        expect(error('mysql://h:99999/d').code).toBe('PORT');
        expect(error('mysql://u:100%@h/d').code).toBe('ESCAPE');
        expect(error('mysql://u@/d').code).toBe('HOST');
    });

    it('never puts the password in a message', () => {
        const message = error('mysql://u:hunter2%@h/d').message;
        expect(message).not.toContain('hunter2');
    });
});

describe('formatting', () => {
    const roundTrip = (text: string) => {
        const parsed = ok(text);
        const { password, ...rest } = parsed;
        return formatConnectionString(rest as ParsedConnection, password);
    };

    it('writes what it reads', () => {
        expect(roundTrip('mysql://app:pw@db:3306/shop?ssl-mode=REQUIRED&charset=utf8mb4')).toBe(
            'mysql://app:pw@db:3306/shop?ssl-mode=REQUIRED&charset=utf8mb4',
        );
        expect(
            roundTrip('postgresql://u:p@h:5432/d?sslmode=require&options=-c%20search_path%3Dx'),
        ).toBe('postgresql://u:p@h:5432/d?sslmode=require&options=-c%20search_path%3Dx');
        expect(roundTrip('mongodb+srv://u:p@c0.example.net/db?retryWrites=true&w=majority')).toBe(
            'mongodb+srv://u:p@c0.example.net/db?retryWrites=true&w=majority',
        );
        expect(roundTrip('mongodb://u:p@a:27017,b:27018/db?replicaSet=rs0&tls=true')).toBe(
            'mongodb://u:p@a:27017,b:27018/db?tls=true&replicaSet=rs0',
        );
    });

    it('escapes special characters, and masks or omits the password', () => {
        const source = { engine: 'mysql', host: 'h', port: 3306, username: 'a@b' };
        expect(formatConnectionString(source, 'p:w/@')).toBe('mysql://a%40b:p%3Aw%2F%40@h:3306');
        expect(formatConnectionString(source, 'secret', { mask: true })).toBe(
            'mysql://a%40b:****@h:3306',
        );
        expect(formatConnectionString(source)).toBe('mysql://a%40b@h:3306');
    });

    it('redacts passwords in free text', () => {
        expect(redactConnectionString('failed for mysql://u:secret@host/db')).toBe(
            'failed for mysql://u:****@host/db',
        );
    });
});
