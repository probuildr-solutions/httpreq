/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
    FLAG_ERROR,
    FLAG_UNTERMINATED,
    INITIAL_LEX_STATE,
    SqlScanner,
    StatementKind,
    isReadOnlyKind,
    kindOf,
    tokenize,
    tokenizeLine,
    type SqlDialect,
} from './index';

interface Found {
    text: string;
    kind: number;
    unterminated: boolean;
    error: boolean;
}

const scan = (text: string, dialect: SqlDialect = 'mysql', chunkSize = Infinity): Found[] => {
    const bytes = new TextEncoder().encode(text);
    const scanner = new SqlScanner(dialect);
    const step = Math.min(chunkSize, Math.max(1, bytes.length));
    for (let offset = 0; offset < bytes.length; offset += step) {
        scanner.feed(bytes.subarray(offset, offset + step), offset);
    }
    const index = scanner.finish(bytes.length);
    const out: Found[] = [];
    for (let i = 0; i < index.count; i++) {
        const range = index.get(i)!;
        out.push({
            text: new TextDecoder().decode(bytes.subarray(range.start, range.end)),
            kind: kindOf(range.flags),
            unterminated: (range.flags & FLAG_UNTERMINATED) !== 0,
            error: (range.flags & FLAG_ERROR) !== 0,
        });
    }
    return out;
};

const texts = (found: Found[]) => found.map((f) => f.text.trim());

describe('statement boundaries', () => {
    it('splits on semicolons and keeps ranges contiguous', () => {
        const found = scan('SELECT 1;\nINSERT INTO t VALUES (1);\n  UPDATE t SET a = 2;');
        expect(texts(found)).toEqual([
            'SELECT 1;',
            'INSERT INTO t VALUES (1);',
            'UPDATE t SET a = 2;',
        ]);
        expect(found.map((f) => f.kind)).toEqual([
            StatementKind.Select,
            StatementKind.Insert,
            StatementKind.Update,
        ]);
        expect(found.map((f) => f.text).join('')).toBe(
            'SELECT 1;\nINSERT INTO t VALUES (1);\n  UPDATE t SET a = 2;',
        );
    });

    it('classifies every statement kind it knows', () => {
        const kinds = scan(
            'select 1; insert into t values (1); update t set a=1; delete from t; create table t (a int); ' +
                'alter table t add b int; drop table t; truncate t; begin; commit; rollback; set a=1; use d; ' +
                'show tables; explain select 1; call p(); grant all on d.* to u; with x as (select 1) select * from x; ' +
                '(select 1); frobnicate;',
        ).map((f) => f.kind);
        expect(kinds).toEqual([
            StatementKind.Select,
            StatementKind.Insert,
            StatementKind.Update,
            StatementKind.Delete,
            StatementKind.Create,
            StatementKind.Alter,
            StatementKind.Drop,
            StatementKind.Truncate,
            StatementKind.Transaction,
            StatementKind.Transaction,
            StatementKind.Transaction,
            StatementKind.Set,
            StatementKind.Use,
            StatementKind.Show,
            StatementKind.Explain,
            StatementKind.Call,
            StatementKind.Grant,
            StatementKind.With,
            StatementKind.Select,
            StatementKind.Other,
        ]);
        expect(isReadOnlyKind(StatementKind.Select)).toBe(true);
        expect(isReadOnlyKind(StatementKind.Delete)).toBe(false);
        expect(isReadOnlyKind(StatementKind.With)).toBe(false);
        expect(isReadOnlyKind(StatementKind.Explain)).toBe(false);
    });

    it('does not split on a semicolon inside strings, identifiers or comments', () => {
        const found = scan(
            'SELECT \'a;b\', "c;d", `e;f`; -- trailing ; comment\n' +
                '/* block ; comment */ SELECT 2; # hash ; comment\nSELECT 3;',
        );
        expect(texts(found)).toEqual([
            'SELECT \'a;b\', "c;d", `e;f`;',
            '-- trailing ; comment\n/* block ; comment */ SELECT 2;',
            '# hash ; comment\nSELECT 3;',
        ]);
    });

    it('understands escaped quotes in each form', () => {
        expect(texts(scan("SELECT 'it''s; fine'; SELECT 2;"))).toEqual([
            "SELECT 'it''s; fine';",
            'SELECT 2;',
        ]);
        expect(texts(scan("SELECT 'it\\'s; fine'; SELECT 2;"))).toEqual([
            "SELECT 'it\\'s; fine';",
            'SELECT 2;',
        ]);
        expect(texts(scan("SELECT 'a\\\\'; SELECT 2;"))).toEqual(["SELECT 'a\\\\';", 'SELECT 2;']);
        expect(texts(scan('SELECT "a""b;"; SELECT 2;'))).toEqual(['SELECT "a""b;";', 'SELECT 2;']);
        expect(texts(scan('SELECT `a``b;`; SELECT 2;'))).toEqual(['SELECT `a``b;`;', 'SELECT 2;']);
    });

    it('treats MySQL --x as code but -- x as a comment', () => {
        expect(texts(scan('SELECT 1 --1; SELECT 2;'))).toEqual(['SELECT 1 --1;', 'SELECT 2;']);
        expect(texts(scan('SELECT 1 -- 1; hidden\n; SELECT 2;'))).toEqual([
            'SELECT 1 -- 1; hidden\n;',
            'SELECT 2;',
        ]);
    });

    it('ignores stray terminators and trailing comments, and flags a missing final terminator', () => {
        expect(texts(scan(';;SELECT 1;;\n-- the end\n'))).toEqual([';;SELECT 1;']);
        const last = scan('SELECT 1; SELECT 2')[1]!;
        expect(last.unterminated).toBe(true);
        expect(last.error).toBe(false);
        expect(scan('')).toEqual([]);
        expect(scan('   \n\t')).toEqual([]);
    });

    it('flags a file that ends inside a quote or comment', () => {
        for (const sql of ["SELECT 'oops", 'SELECT "oops', 'SELECT `oops', 'SELECT 1 /* oops']) {
            const [only] = scan(sql);
            expect(only?.unterminated, sql).toBe(true);
            expect(only?.error, sql).toBe(true);
        }
    });

    it('handles Windows line endings and multi-byte text', () => {
        expect(texts(scan("SELECT 'é日本';\r\nSELECT 2;\r\n"))).toEqual([
            "SELECT 'é日本';",
            'SELECT 2;',
        ]);
    });
});

describe('MySQL DELIMITER', () => {
    const script = [
        'SELECT 1;',
        'DELIMITER $$',
        'CREATE PROCEDURE p()',
        'BEGIN',
        "    SELECT 'a;b';",
        '    UPDATE t SET n = n + 1;',
        'END$$',
        'DELIMITER ;',
        'SELECT 2;',
        '',
    ].join('\n');

    it('keeps a stored procedure in one piece and reports the directives', () => {
        const found = scan(script);
        expect(found.map((f) => f.kind)).toEqual([
            StatementKind.Select,
            StatementKind.Delimiter,
            StatementKind.Create,
            StatementKind.Delimiter,
            StatementKind.Select,
        ]);
        expect(found[2]!.text).toContain('UPDATE t SET n = n + 1;');
        expect(found[2]!.text.trim().endsWith('END$$')).toBe(true);
        expect(texts(found).at(-1)).toBe('SELECT 2;');
    });

    it('supports multi-byte delimiters, including ones that start like ordinary text', () => {
        const found = scan(
            'DELIMITER //\nSELECT 1; SELECT 2//\nSELECT /* // */ 3//\nDELIMITER ;\nSELECT 4;',
        );
        expect(texts(found)).toEqual([
            'DELIMITER //',
            'SELECT 1; SELECT 2//',
            'SELECT /* // */ 3//',
            'DELIMITER ;',
            'SELECT 4;',
        ]);
        expect(found.map((f) => f.kind)).toEqual([
            StatementKind.Delimiter,
            StatementKind.Select,
            StatementKind.Select,
            StatementKind.Delimiter,
            StatementKind.Select,
        ]);
    });

    it('accepts the directive in any case and without a trailing newline', () => {
        expect(texts(scan('delimiter ;;'))).toEqual(['delimiter ;;']);
        expect(texts(scan('DELIMITER $$\nSELECT 1$$'))).toEqual(['DELIMITER $$', 'SELECT 1$$']);
    });
});

describe('PostgreSQL', () => {
    it('keeps dollar-quoted function bodies together', () => {
        const sql =
            'CREATE FUNCTION f() RETURNS int AS $$\nBEGIN\n  PERFORM 1; RETURN 2;\nEND;\n$$ LANGUAGE plpgsql;\nSELECT f();';
        const found = scan(sql, 'postgresql');
        expect(found).toHaveLength(2);
        expect(found[0]!.text).toContain('PERFORM 1; RETURN 2;');
        expect(found[0]!.kind).toBe(StatementKind.Create);
    });

    it('matches tagged dollar quotes and does not close on a different tag', () => {
        const sql = 'DO $body$ BEGIN $x$; $$ ; END $body$;\nSELECT 2;';
        expect(texts(scan(sql, 'postgresql'))).toEqual([
            'DO $body$ BEGIN $x$; $$ ; END $body$;',
            'SELECT 2;',
        ]);
    });

    it('does not mistake positional parameters or identifiers for dollar quotes', () => {
        expect(texts(scan('SELECT $1, a$b; SELECT $2;', 'postgresql'))).toEqual([
            'SELECT $1, a$b;',
            'SELECT $2;',
        ]);
    });

    it('nests block comments, and treats backticks and # as ordinary text', () => {
        expect(texts(scan('SELECT 1 /* a /* b ; */ c ; */; SELECT 2;', 'postgresql'))).toEqual([
            'SELECT 1 /* a /* b ; */ c ; */;',
            'SELECT 2;',
        ]);
        expect(texts(scan('SELECT 1 # x; SELECT 2;', 'postgresql'))).toEqual([
            'SELECT 1 # x;',
            'SELECT 2;',
        ]);
    });

    it('applies backslash escapes only inside E strings, and treats -- as a comment without a space', () => {
        expect(texts(scan("SELECT E'a\\'b;'; SELECT 2;", 'postgresql'))).toEqual([
            "SELECT E'a\\'b;';",
            'SELECT 2;',
        ]);
        expect(texts(scan("SELECT 'a\\'; SELECT 2;", 'postgresql'))).toEqual([
            "SELECT 'a\\';",
            'SELECT 2;',
        ]);
        expect(texts(scan('SELECT 1 --x;\n; SELECT 2;', 'postgresql'))).toEqual([
            'SELECT 1 --x;\n;',
            'SELECT 2;',
        ]);
    });

    it('does not treat "..." as a string', () => {
        expect(texts(scan('SELECT "a\\"; SELECT 2;', 'postgresql'))).toEqual([
            'SELECT "a\\";',
            'SELECT 2;',
        ]);
    });

    it('does not recognize DELIMITER as a command', () => {
        expect(scan('DELIMITER $$\nSELECT 1;', 'postgresql').map((f) => f.kind)).toEqual([
            StatementKind.Delimiter,
        ]);
        // It is a plain statement kind in PostgreSQL's eyes, running up to the next semicolon.
        expect(texts(scan('DELIMITER $$\nSELECT 1;', 'postgresql'))).toEqual([
            'DELIMITER $$\nSELECT 1;',
        ]);
    });
});

describe('chunk invariance', () => {
    const mysqlScript = [
        '-- header comment; with a semicolon',
        "SET NAMES 'utf8mb4';",
        '/* multi',
        '   line ; comment */',
        "CREATE TABLE `t;1` (id INT, name VARCHAR(10) DEFAULT 'a;b', note TEXT);",
        "INSERT INTO `t;1` VALUES (1, 'it''s', 'back\\\\slash'), (2, 'é日本', \"dq;\\\"x\");",
        'DELIMITER $$',
        'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW',
        'BEGIN',
        "    SET NEW.name = CONCAT(NEW.name, ';');",
        'END$$',
        'DELIMITER ;',
        '# hash comment',
        'SELECT 1 --1;',
        'SELECT 2 -- two',
        ';',
        "SELECT 'unterminated",
    ].join('\n');

    const pgScript = [
        '-- comment',
        'CREATE FUNCTION f(a int) RETURNS int AS $fn$',
        'BEGIN RETURN a; /* ; */ END; $fn$ LANGUAGE plpgsql;',
        "SELECT E'it\\'s;', $1, a$b, 'x''y';",
        'SELECT 1 /* outer /* inner ; */ still ; */;',
        'DO $$ BEGIN PERFORM 1; END $$;',
        'SELECT "quoted;ident";',
        'SELECT 1',
    ].join('\n');

    for (const [name, dialect, script] of [
        ['MySQL', 'mysql', mysqlScript],
        ['PostgreSQL', 'postgresql', pgScript],
    ] as const) {
        it(`${name}: every chunking of the same bytes gives the same statements`, () => {
            const whole = scan(script, dialect);
            expect(whole.length).toBeGreaterThan(5);
            for (const chunkSize of [1, 2, 3, 5, 7, 13, 64, 1000]) {
                expect(scan(script, dialect, chunkSize), `chunk ${chunkSize}`).toEqual(whole);
            }
        });
    }

    it('survives a pseudo-random mix of tricky fragments at every chunk size', () => {
        const fragments = [
            'SELECT 1;',
            " 'a;b' ",
            ' "x;y" ',
            ' `p;q` ',
            ' -- c;\n',
            ' /* c ; */ ',
            ' # h;\n',
            ' $$ a;b $$ ',
            ' $t$ ; $t$ ',
            " E'\\';' ",
            ';',
            '\n',
            ' ',
            'DELIMITER //\n',
            'DELIMITER ;\n',
            '//',
        ];
        let state = 7;
        const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
        for (let round = 0; round < 40; round++) {
            let text = '';
            for (let i = 0; i < 40; i++) text += fragments[next() % fragments.length];
            for (const dialect of ['mysql', 'postgresql'] as const) {
                const whole = scan(text, dialect);
                for (const chunkSize of [1, 3, 11]) {
                    expect(
                        scan(text, dialect, chunkSize),
                        `${dialect} ${chunkSize} ${JSON.stringify(text)}`,
                    ).toEqual(whole);
                }
            }
        }
    });
});

describe('tokenizer', () => {
    const types = (text: string, dialect: SqlDialect = 'mysql') =>
        tokenize(text, dialect)
            .filter((t) => t.type !== 'whitespace')
            .map((t) => [t.type, text.slice(t.start, t.end)]);

    it('classifies the common token types', () => {
        expect(types("SELECT a, `b c`, 'x', 12.5 FROM t -- hi")).toEqual([
            ['keyword', 'SELECT'],
            ['identifier', 'a'],
            ['punctuation', ','],
            ['quotedIdentifier', '`b c`'],
            ['punctuation', ','],
            ['string', "'x'"],
            ['punctuation', ','],
            ['number', '12.5'],
            ['keyword', 'FROM'],
            ['identifier', 't'],
            ['comment', '-- hi'],
        ]);
    });

    it('carries multi-line strings and comments from one line to the next', () => {
        const first = tokenizeLine("SELECT 'abc", INITIAL_LEX_STATE, 'mysql');
        expect(first.state.mode).toBe('string');
        const second = tokenizeLine("def' , 1", first.state, 'mysql');
        expect(second.tokens.map((t) => t.type)).toEqual([
            'string',
            'whitespace',
            'punctuation',
            'whitespace',
            'number',
        ]);
        expect(second.state.mode).toBe('code');

        const open = tokenizeLine('/* a', INITIAL_LEX_STATE, 'mysql');
        expect(open.state.mode).toBe('block');
        expect(tokenizeLine('b */ SELECT', open.state, 'mysql').state.mode).toBe('code');
    });

    it('handles PostgreSQL dollar quotes and parameters', () => {
        expect(types('SELECT $1, $$ x $$', 'postgresql')).toEqual([
            ['keyword', 'SELECT'],
            ['parameter', '$1'],
            ['punctuation', ','],
            ['string', '$$ x $$'],
        ]);
        const open = tokenizeLine('DO $f$ BEGIN', INITIAL_LEX_STATE, 'postgresql');
        expect(open.state).toMatchObject({ mode: 'dollar', quote: '$f$' });
    });

    it('covers every character exactly once', () => {
        const text = "SELECT 'a''b', `c`, 1.5e3 /* x */ -- y\nFROM t WHERE a<>1;";
        const tokens = tokenize(text, 'mysql');
        let at = 0;
        for (const token of tokens) {
            if (text[token.start] === '\n') at++;
            expect(token.start).toBeGreaterThanOrEqual(at);
            at = token.end;
        }
    });
});
