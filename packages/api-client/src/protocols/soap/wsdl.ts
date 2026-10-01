/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import {
    AppError,
    type SoapVersion,
    type WsdlDescription,
    type WsdlOperation,
} from '@httpreq/shared';
import { escapeXml, parseXml } from './xml';

/**
 * WSDL 1.1 discovery: which operations a service offers, where, with which SOAPAction, and a
 * skeleton of the body each one expects. The document is untrusted input, so it goes through
 * {@link parseXml} (no DTDs, bounded size) and the schema walk is bounded in depth and breadth.
 */

const WSDL_SOAP11 = 'http://schemas.xmlsoap.org/wsdl/soap/';
const WSDL_SOAP12 = 'http://schemas.xmlsoap.org/wsdl/soap12/';
const XSD = 'http://www.w3.org/2001/XMLSchema';
const MAX_DEPTH = 6;
const MAX_ELEMENTS = 400;

const local = (name: string | null) => (name ?? '').replace(/^.*:/, '');

const children = (parent: Element, name: string, namespace = '*'): Element[] =>
    Array.from(parent.children).filter(
        (child) =>
            child.localName === name && (namespace === '*' || child.namespaceURI === namespace),
    );

const all = (document: Document, name: string): Element[] =>
    Array.from(document.getElementsByTagNameNS('*', name));

interface SchemaIndex {
    elements: Map<string, Element>;
    types: Map<string, Element>;
    targetNamespaces: Map<Element, string>;
}

const indexSchemas = (document: Document): SchemaIndex => {
    const index: SchemaIndex = {
        elements: new Map(),
        types: new Map(),
        targetNamespaces: new Map(),
    };
    for (const schema of all(document, 'schema').filter((s) => s.namespaceURI === XSD)) {
        const targetNamespace = schema.getAttribute('targetNamespace') ?? '';
        for (const element of children(schema, 'element')) {
            const name = element.getAttribute('name') ?? '';
            index.elements.set(name, element);
            index.targetNamespaces.set(element, targetNamespace);
        }
        for (const type of [
            ...children(schema, 'complexType'),
            ...children(schema, 'simpleType'),
        ]) {
            index.types.set(type.getAttribute('name') ?? '', type);
            index.targetNamespaces.set(type, targetNamespace);
        }
    }
    return index;
};

/** Whether a local element is in the schema's target namespace (`form` or `elementFormDefault`). */
const isQualified = (declaration: Element): boolean => {
    const form = declaration.getAttribute('form');
    if (form) return form === 'qualified';
    let node: Element | null = declaration;
    while (node && node.localName !== 'schema') node = node.parentElement;
    return node?.getAttribute('elementFormDefault') === 'qualified';
};

const builtinSample = (type: string): string => {
    switch (local(type)) {
        case 'boolean':
            return 'false';
        case 'int':
        case 'integer':
        case 'long':
        case 'short':
        case 'byte':
        case 'decimal':
        case 'double':
        case 'float':
        case 'unsignedInt':
        case 'unsignedLong':
            return '0';
        case 'date':
            return '2024-01-01';
        case 'dateTime':
            return '2024-01-01T00:00:00Z';
        case 'base64Binary':
            return '';
        default:
            return '?';
    }
};

class SampleWriter {
    private count = 0;

    constructor(
        private readonly schemas: SchemaIndex,
        private readonly prefix: string,
    ) {}

    /** XML for one `<element>` declaration, indented `level` steps. */
    element(declaration: Element, level: number, seen: string[]): string {
        if (this.count++ > MAX_ELEMENTS || level > MAX_DEPTH) return '';
        const name = declaration.getAttribute('name') ?? local(declaration.getAttribute('ref'));
        const reference = declaration.getAttribute('ref');
        if (reference && !declaration.getAttribute('name')) {
            const target = this.schemas.elements.get(local(reference));
            return target ? this.element(target, level, seen) : '';
        }
        const qualified = level === 0 || isQualified(declaration);
        const tag = qualified ? `${this.prefix}:${name}` : name;
        const pad = '  '.repeat(level);
        const inline = children(declaration, 'complexType')[0];
        const typeName = declaration.getAttribute('type');
        const complex = inline ?? (typeName ? this.schemas.types.get(local(typeName)) : undefined);
        if (complex && complex.localName === 'complexType') {
            const key = complex.getAttribute('name') ?? '';
            if (key && seen.includes(key)) return `${pad}<${tag}/>\n`;
            const body = this.complex(complex, level + 1, key ? [...seen, key] : seen);
            return body ? `${pad}<${tag}>\n${body}${pad}</${tag}>\n` : `${pad}<${tag}></${tag}>\n`;
        }
        const simple = complex ? '?' : builtinSample(typeName ?? 'string');
        return `${pad}<${tag}>${escapeXml(simple)}</${tag}>\n`;
    }

    private complex(type: Element, level: number, seen: string[]): string {
        let xml = '';
        const visit = (node: Element) => {
            for (const child of Array.from(node.children)) {
                switch (child.localName) {
                    case 'sequence':
                    case 'all':
                    case 'choice':
                    case 'complexContent':
                    case 'extension':
                    case 'restriction':
                        if (child.localName === 'extension') {
                            const base = this.schemas.types.get(local(child.getAttribute('base')));
                            if (base) xml += this.complex(base, level, seen);
                        }
                        visit(child);
                        break;
                    case 'element':
                        xml += this.element(child, level, seen);
                        break;
                }
            }
        };
        visit(type);
        return xml;
    }
}

interface PortTypeOperation {
    input: string;
    documentation: string;
}

/** Parses a WSDL 1.1 document. Throws `INVALID_REQUEST` with a readable reason when it cannot. */
export const parseWsdl = (text: string): WsdlDescription => {
    const parsed = parseXml(text);
    if (!parsed.ok)
        throw new AppError('INVALID_REQUEST', `The WSDL is not usable: ${parsed.message}`);
    const { document } = parsed;
    const root = document.documentElement;
    if (root.localName === 'description') {
        throw new AppError(
            'INVALID_REQUEST',
            'WSDL 2.0 is not supported. Use a WSDL 1.1 document (the root element is <definitions>).',
        );
    }
    if (root.localName !== 'definitions') {
        throw new AppError(
            'INVALID_REQUEST',
            'The document is not a WSDL (no <definitions> root).',
        );
    }
    const targetNamespace = root.getAttribute('targetNamespace') ?? '';
    const schemas = indexSchemas(document);

    const messages = new Map<string, Element[]>();
    for (const message of children(root, 'message')) {
        messages.set(message.getAttribute('name') ?? '', children(message, 'part'));
    }
    const portTypes = new Map<string, Map<string, PortTypeOperation>>();
    for (const portType of children(root, 'portType')) {
        const operations = new Map<string, PortTypeOperation>();
        for (const operation of children(portType, 'operation')) {
            operations.set(operation.getAttribute('name') ?? '', {
                input: local(children(operation, 'input')[0]?.getAttribute('message') ?? null),
                documentation: (children(operation, 'documentation')[0]?.textContent ?? '').trim(),
            });
        }
        portTypes.set(portType.getAttribute('name') ?? '', operations);
    }
    const endpoints = new Map<string, string>();
    for (const service of children(root, 'service')) {
        for (const port of children(service, 'port')) {
            const address = Array.from(port.children).find(
                (child) => child.localName === 'address',
            );
            const location = address?.getAttribute('location');
            if (location) endpoints.set(local(port.getAttribute('binding')), location);
        }
    }

    const operations: WsdlOperation[] = [];
    for (const binding of children(root, 'binding')) {
        const soap = Array.from(binding.children).find(
            (child) =>
                child.localName === 'binding' &&
                (child.namespaceURI === WSDL_SOAP11 || child.namespaceURI === WSDL_SOAP12),
        );
        if (!soap) continue; // An HTTP or MIME binding: not SOAP.
        const version: SoapVersion = soap.namespaceURI === WSDL_SOAP12 ? '1.2' : '1.1';
        const bindingName = binding.getAttribute('name') ?? '';
        const style = soap.getAttribute('style') ?? 'document';
        const portType = portTypes.get(local(binding.getAttribute('type')));
        for (const operation of children(binding, 'operation')) {
            const name = operation.getAttribute('name') ?? '';
            const soapOperation = Array.from(operation.children).find(
                (child) => child.localName === 'operation',
            );
            const declared = portType?.get(name);
            const parts = messages.get(declared?.input ?? '') ?? [];
            const prefix = 'tns';
            const writer = new SampleWriter(schemas, prefix);
            let inner = '';
            let rootNamespace = targetNamespace;
            if (style === 'rpc') {
                inner =
                    `<${prefix}:${name} xmlns:${prefix}="${escapeXml(targetNamespace)}">\n` +
                    parts
                        .map(
                            (part) =>
                                `  <${part.getAttribute('name')}>${builtinSample(part.getAttribute('type') ?? '')}</${part.getAttribute('name')}>\n`,
                        )
                        .join('') +
                    `</${prefix}:${name}>`;
            } else {
                for (const part of parts) {
                    const elementName = local(part.getAttribute('element'));
                    const declaration = schemas.elements.get(elementName);
                    if (!declaration) continue;
                    rootNamespace = schemas.targetNamespaces.get(declaration) ?? targetNamespace;
                    const xml = writer.element(declaration, 0, []).trimEnd();
                    inner += xml.replace(
                        new RegExp(`^<${prefix}:${elementName}`),
                        `<${prefix}:${elementName} xmlns:${prefix}="${escapeXml(rootNamespace)}"`,
                    );
                }
            }
            operations.push({
                name,
                id: `${bindingName}.${name}`,
                soapAction: soapOperation?.getAttribute('soapAction') ?? '',
                version,
                endpoint: endpoints.get(bindingName) ?? '',
                sampleBody: inner,
                documentation: declared?.documentation ?? '',
            });
        }
    }
    if (operations.length === 0) {
        throw new AppError('INVALID_REQUEST', 'The WSDL describes no SOAP operations.');
    }
    return { targetNamespace, operations };
};
