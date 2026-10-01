/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import { describe, expect, it } from 'vitest';
import {
    createEmptyRequest,
    createGrpcConfig,
    createMqttConfig,
    createSoapConfig,
    type GrpcResponse,
    type HttpRequest,
    type HttpResponse,
    type HttpRuntime,
    type PreparedRequest,
} from '@httpreq/shared';
import { createWorkspace } from '@httpreq/workspace';
import { buildRequest, type PipelineContext } from '../pipeline';
import {
    buildGrpcCall,
    buildMqttPublish,
    buildMqttConnection,
    buildSoapEnvelope,
    describeProto,
    encodeMessage,
    executeProtocolRequest,
    grpcToHttpResponse,
    loadProtoRoot,
    parseWsdl,
    parseXml,
    resolveMethod,
    sampleRequestJson,
    UnavailableGrpcRuntime,
    xmlProblem,
} from './index';

const context = (overrides: Partial<PipelineContext> = {}): PipelineContext => ({
    workspace: createWorkspace('Test'),
    environment: null,
    ...overrides,
});

const PROTO = `
syntax = "proto3";
package acme.orders;
import "google/protobuf/timestamp.proto";

service OrderService {
    rpc Get (GetOrderRequest) returns (Order);
    rpc Watch (GetOrderRequest) returns (stream Order);
    rpc Upload (stream Order) returns (Order);
}

message GetOrderRequest { string order_id = 1; int32 quantity = 2; }
message Order {
    string id = 1;
    int64 total_cents = 2;
    Status status = 3;
    repeated string tags = 4;
    google.protobuf.Timestamp created = 5;
}
enum Status { UNKNOWN = 0; PAID = 1; }
`;

const grpcRequest = (patch: Partial<HttpRequest> = {}): HttpRequest => ({
    ...createEmptyRequest(),
    protocol: 'grpc',
    url: 'grpc://localhost:50051',
    method: 'POST',
    grpc: {
        ...createGrpcConfig(),
        protoFiles: [{ name: 'orders.proto', content: PROTO }],
        service: 'acme.orders.OrderService',
        method: 'Get',
    },
    body: { ...createEmptyRequest().body, mode: 'json', json: '{"orderId":"A-1","quantity":2}' },
    ...patch,
});

describe('SOAP', () => {
    it('wraps a body in a version 1.1 envelope with its headers', () => {
        const xml = buildSoapEnvelope(
            { ...createSoapConfig(), headerXml: '<auth>token</auth>' },
            '<Add xmlns="http://tempuri.org/"><a>1</a></Add>',
        );
        expect(xml).toContain('xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"');
        expect(xml).toContain('<soap:Header>');
        expect(xml).toContain('<auth>token</auth>');
        expect(xml).toContain('<soap:Body>');
        expect(xmlProblem(xml)).toBeNull();
    });

    it('sends a complete envelope untouched', () => {
        const envelope = '<?xml version="1.0"?><s:Envelope xmlns:s="x"><s:Body/></s:Envelope>';
        expect(buildSoapEnvelope(createSoapConfig(), envelope)).toBe(envelope);
    });

    it('builds an ordinary HTTP POST with the SOAP 1.1 headers', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            protocol: 'soap',
            url: 'https://example.com/calc.asmx',
            method: 'GET',
            soap: { ...createSoapConfig(), action: 'http://tempuri.org/Add' },
            body: { ...createEmptyRequest().body, text: '<Add/>' },
        };
        const { prepared } = await buildRequest(request, context());
        expect(prepared.method).toBe('POST');
        expect(prepared.headers['Content-Type']).toBe('text/xml; charset=utf-8');
        expect(prepared.headers['SOAPAction']).toBe('"http://tempuri.org/Add"');
        expect(prepared.body).toMatchObject({ kind: 'text' });
        expect((prepared.body as { text: string }).text).toContain('<soap:Body>');
    });

    it('puts the action in the Content-Type for SOAP 1.2', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            protocol: 'soap',
            url: 'https://example.com/svc',
            soap: { ...createSoapConfig(), version: '1.2', action: 'urn:Do' },
            body: { ...createEmptyRequest().body, text: '<Do/>' },
        };
        const { prepared } = await buildRequest(request, context());
        expect(prepared.headers['Content-Type']).toBe(
            'application/soap+xml; charset=utf-8; action="urn:Do"',
        );
        expect(prepared.headers['SOAPAction']).toBeUndefined();
    });

    it('does not let an action inject headers', async () => {
        const request: HttpRequest = {
            ...createEmptyRequest(),
            protocol: 'soap',
            url: 'https://example.com/svc',
            soap: { ...createSoapConfig(), action: 'x\r\nX-Evil: 1' },
        };
        await expect(buildRequest(request, context())).rejects.toThrow(/line breaks/);
    });

    it('leaves plain HTTP requests exactly as they were', async () => {
        const request = {
            ...createEmptyRequest(),
            url: 'https://example.com',
            method: 'GET' as const,
        };
        const { prepared } = await buildRequest(request, context());
        expect(prepared.method).toBe('GET');
        expect(prepared.headers).toEqual({});
    });
});

describe('XML safety', () => {
    it('refuses documents with a DOCTYPE or entity declarations', () => {
        const result = parseXml('<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>');
        expect(result.ok).toBe(false);
    });

    it('reports malformed XML', () => {
        expect(xmlProblem('<a><b></a>')).toBeTruthy();
        expect(xmlProblem('<a>{{token}}</a>')).toBeNull();
    });
});

const WSDL = `<?xml version="1.0"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
    xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:tns="http://tempuri.org/" targetNamespace="http://tempuri.org/">
  <types>
    <xs:schema targetNamespace="http://tempuri.org/" elementFormDefault="qualified">
      <xs:element name="Add">
        <xs:complexType><xs:sequence>
          <xs:element name="a" type="xs:int"/>
          <xs:element name="b" type="xs:int"/>
        </xs:sequence></xs:complexType>
      </xs:element>
      <xs:element name="AddResponse">
        <xs:complexType><xs:sequence><xs:element name="AddResult" type="xs:int"/></xs:sequence></xs:complexType>
      </xs:element>
    </xs:schema>
  </types>
  <message name="AddIn"><part name="parameters" element="tns:Add"/></message>
  <message name="AddOut"><part name="parameters" element="tns:AddResponse"/></message>
  <portType name="CalcSoap">
    <operation name="Add"><documentation>Adds two numbers</documentation>
      <input message="tns:AddIn"/><output message="tns:AddOut"/></operation>
  </portType>
  <binding name="CalcSoap" type="tns:CalcSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <operation name="Add"><soap:operation soapAction="http://tempuri.org/Add"/></operation>
  </binding>
  <service name="Calc"><port name="CalcSoap" binding="tns:CalcSoap">
    <soap:address location="http://example.com/calc.asmx"/></port></service>
</definitions>`;

describe('WSDL discovery', () => {
    it('lists operations with action, endpoint and a body skeleton', () => {
        const wsdl = parseWsdl(WSDL);
        expect(wsdl.operations).toHaveLength(1);
        const [operation] = wsdl.operations;
        expect(operation).toMatchObject({
            name: 'Add',
            soapAction: 'http://tempuri.org/Add',
            endpoint: 'http://example.com/calc.asmx',
            version: '1.1',
            documentation: 'Adds two numbers',
        });
        expect(operation!.sampleBody).toContain('<tns:Add xmlns:tns="http://tempuri.org/">');
        expect(operation!.sampleBody).toContain('<tns:a>0</tns:a>');
        expect(xmlProblem(operation!.sampleBody)).toBeNull();
    });

    it('rejects documents that are not WSDL 1.1', () => {
        expect(() => parseWsdl('<x/>')).toThrow(/not a WSDL/);
        expect(() => parseWsdl('<description/>')).toThrow(/WSDL 2.0/);
        expect(() => parseWsdl('<!DOCTYPE a><definitions/>')).toThrow(/DOCTYPE/);
    });
});

describe('gRPC definitions', () => {
    it('discovers services and methods, with their streaming kinds', () => {
        const { services } = describeProto([{ name: 'orders.proto', content: PROTO }]);
        expect(services).toHaveLength(1);
        expect(services[0]!.fullName).toBe('acme.orders.OrderService');
        expect(
            services[0]!.methods.map((m) => [m.name, m.clientStreaming, m.serverStreaming]),
        ).toEqual([
            ['Get', false, false],
            ['Watch', false, true],
            ['Upload', true, false],
        ]);
    });

    it('resolves well-known imports and reports missing ones', () => {
        expect(() => loadProtoRoot([{ name: 'a.proto', content: PROTO }])).not.toThrow();
        expect(() =>
            loadProtoRoot([{ name: 'a.proto', content: 'syntax="proto3"; import "nope.proto";' }]),
        ).toThrow(/nope\.proto/);
    });

    it('rejects malformed definitions with the parser message', () => {
        expect(() => loadProtoRoot([{ name: 'a.proto', content: 'message {' }])).toThrow();
        expect(() => loadProtoRoot([])).toThrow(/Add a .proto/);
    });

    it('generates a request skeleton', () => {
        const json = JSON.parse(
            sampleRequestJson(
                [{ name: 'orders.proto', content: PROTO }],
                'acme.orders.OrderService',
                'Get',
            ),
        );
        expect(json).toEqual({ order_id: '', quantity: 0 });
    });

    it('encodes JSON accepting camelCase, and rejects unknown fields', () => {
        const root = loadProtoRoot([{ name: 'orders.proto', content: PROTO }]);
        const { requestType } = resolveMethod(root, 'acme.orders.OrderService', 'Get');
        const bytes = encodeMessage(requestType, '{"orderId":"A-1","quantity":2}');
        expect(bytes.length).toBeGreaterThan(0);
        expect(() => encodeMessage(requestType, '{"orderid":"x"}')).toThrow(/not a field/);
        expect(() => encodeMessage(requestType, '{oops')).toThrow(/not valid JSON/);
        expect(() => encodeMessage(requestType, '[]')).toThrow(/JSON object/);
    });
});

describe('gRPC calls', () => {
    it('builds a call with metadata from headers and authorization', async () => {
        const request = grpcRequest({
            headers: [{ id: '1', key: 'X-Trace', value: 'abc', enabled: true }],
            auth: { type: 'bearer', token: 'tok', prefix: 'Bearer' },
        });
        const { prepared } = await buildGrpcCall(request, context());
        expect(prepared).toMatchObject({
            target: 'localhost:50051',
            tls: false,
            service: 'acme.orders.OrderService',
            method: 'Get',
        });
        expect(prepared.metadata).toEqual({ 'x-trace': 'abc', authorization: 'Bearer tok' });
    });

    it('uses TLS for grpcs:// and the default port', async () => {
        const { prepared } = await buildGrpcCall(
            grpcRequest({ url: 'grpcs://api.example.com' }),
            context(),
        );
        expect(prepared).toMatchObject({ target: 'api.example.com:443', tls: true });
    });

    it('refuses client streaming, a missing method and a bad message', async () => {
        const upload = grpcRequest();
        upload.grpc!.method = 'Upload';
        await expect(buildGrpcCall(upload, context())).rejects.toThrow(/not supported/);

        const none = grpcRequest();
        none.grpc!.method = '';
        await expect(buildGrpcCall(none, context())).rejects.toThrow(/Choose the service/);

        const bad = grpcRequest();
        bad.body.json = '{"nope":1}';
        await expect(buildGrpcCall(bad, context())).rejects.toThrow(/not a field/);
    });

    it('applies pre-request script changes to metadata and message', async () => {
        const scripts = {
            preRequest: (view: { headers: Record<string, string>; body: string | null }) => {
                view.headers['X-Signed'] = 'yes';
                view.body = '{"orderId":"B-2"}';
            },
        };
        const { prepared } = await buildGrpcCall(grpcRequest(), context({ scripts }));
        expect(prepared.metadata['x-signed']).toBe('yes');
        expect(prepared.message).toBe('{"orderId":"B-2"}');
    });

    it('shapes a response like HTTP, keeping the gRPC status', () => {
        const raw: GrpcResponse = {
            status: { code: 0, name: 'OK', details: '' },
            headers: { 'x-h': '1' },
            trailers: { 'x-t': '2' },
            messages: ['{"id":"A-1"}'],
            durationMs: 5,
            sizeBytes: 12,
        };
        const http = grpcToHttpResponse(raw, false);
        expect(http).toMatchObject({ status: 200, statusText: 'OK', grpc: { code: 0 } });
        expect(JSON.parse(http.body)).toEqual({ id: 'A-1' });

        const failed = grpcToHttpResponse(
            { ...raw, status: { code: 14, name: 'UNAVAILABLE', details: 'down' }, messages: [] },
            false,
        );
        expect(failed.status).toBe(503);
        expect(JSON.parse(failed.body)).toMatchObject({ code: 14, details: 'down' });
    });

    it('runs through the registry and refuses where no gRPC runtime exists', async () => {
        const runtimes = { http: {} as HttpRuntime, grpc: new UnavailableGrpcRuntime() };
        await expect(executeProtocolRequest(grpcRequest(), context(), runtimes)).rejects.toThrow(
            /desktop app/,
        );
    });

    it('dispatches HTTP and SOAP to the HTTP runtime', async () => {
        const response: HttpResponse = {
            status: 200,
            statusText: 'OK',
            headers: {},
            body: '<ok/>',
            contentType: 'text/xml',
            durationMs: 1,
            sizeBytes: 5,
        };
        const sent: PreparedRequest[] = [];
        const execute = async (request: PreparedRequest) => {
            sent.push(request);
            return response;
        };
        const runtimes = {
            http: { kind: 'browser', execute } as HttpRuntime,
            grpc: new UnavailableGrpcRuntime(),
        };
        const soap: HttpRequest = {
            ...createEmptyRequest(),
            protocol: 'soap',
            url: 'https://example.com/svc',
            soap: createSoapConfig(),
            body: { ...createEmptyRequest().body, text: '<A/>' },
        };
        const result = await executeProtocolRequest(soap, context(), runtimes);
        expect(result.response.body).toBe('<ok/>');
        expect(sent[0]!.method).toBe('POST');
    });

    it('explains that MQTT connects instead of sending', async () => {
        const runtimes = { http: {} as HttpRuntime, grpc: new UnavailableGrpcRuntime() };
        const mqtt = {
            ...createEmptyRequest(),
            protocol: 'mqtt' as const,
            mqtt: createMqttConfig(),
        };
        await expect(executeProtocolRequest(mqtt, context(), runtimes)).rejects.toThrow(/Connect/);
    });
});

describe('MQTT', () => {
    const mqttRequest = (patch: Partial<HttpRequest> = {}): HttpRequest => ({
        ...createEmptyRequest(),
        protocol: 'mqtt',
        url: 'mqtts://broker.example.com',
        mqtt: createMqttConfig(),
        ...patch,
    });

    it('takes broker credentials from Basic authorization and normalizes the URL', async () => {
        const request = mqttRequest({ auth: { type: 'basic', username: 'ada', password: 'pw' } });
        const { prepared } = await buildMqttConnection(request, context());
        expect(prepared).toMatchObject({
            url: 'mqtts://broker.example.com:8883',
            username: 'ada',
            password: 'pw',
            protocolVersion: 5,
        });
        expect(prepared.clientId).toMatch(/^httpreq-/);
    });

    it('uses a Bearer token as the password and refuses other schemes', async () => {
        const bearer = mqttRequest({ auth: { type: 'bearer', token: 'tok', prefix: 'Bearer' } });
        expect((await buildMqttConnection(bearer, context())).prepared.password).toBe('tok');
        const digest = mqttRequest({ auth: { type: 'digest', username: 'a', password: 'b' } });
        await expect(buildMqttConnection(digest, context())).rejects.toThrow(/Basic or Bearer/);
    });

    it('rejects a non-MQTT URL and invalid subscription filters', async () => {
        await expect(
            buildMqttConnection(mqttRequest({ url: 'https://example.com' }), context()),
        ).rejects.toThrow(/not a MQTT broker scheme/);
        const request = mqttRequest();
        request.mqtt!.subscriptions = [{ id: '1', topic: 'a/#/b', qos: 0, enabled: true }];
        await expect(buildMqttConnection(request, context())).rejects.toThrow(/last level/);
    });

    it('validates what is published', () => {
        const request = mqttRequest();
        request.mqtt!.publishTopic = 'sensors/+';
        expect(() => buildMqttPublish(request, context())).toThrow(/wildcards/);
        request.mqtt!.publishTopic = 'sensors/1';
        request.mqtt!.payloadFormat = 'hex';
        request.body.text = 'zz';
        expect(() => buildMqttPublish(request, context())).toThrow(/hexadecimal/);
        request.body.text = 'de ad be ef';
        expect(buildMqttPublish(request, context())).toMatchObject({
            topic: 'sensors/1',
            format: 'hex',
        });
    });
});
