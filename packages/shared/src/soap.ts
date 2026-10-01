/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

/**
 * SOAP domain model. SOAP travels over HTTP, so a SOAP request is an `HttpRequest` whose
 * `protocol` is `soap` plus this configuration; the transport is the ordinary HTTP runtime.
 */

export const SOAP_VERSIONS = ['1.1', '1.2'] as const;
export type SoapVersion = (typeof SOAP_VERSIONS)[number];

export const isSoapVersion = (value: unknown): value is SoapVersion =>
    typeof value === 'string' && (SOAP_VERSIONS as readonly string[]).includes(value);

export const SOAP_ENVELOPE_NAMESPACE: Record<SoapVersion, string> = {
    '1.1': 'http://schemas.xmlsoap.org/soap/envelope/',
    '1.2': 'http://www.w3.org/2003/05/soap-envelope',
};

export interface SoapConfig {
    version: SoapVersion;
    /** The `SOAPAction` (1.1) or `action` parameter (1.2). Empty sends none. */
    action: string;
    /** Inner XML of `<Header>`, e.g. WS-Security blocks. Empty omits the header element. */
    headerXml: string;
    /** Where the WSDL was imported from, if it was. Informational; never fetched implicitly. */
    wsdlUrl: string;
    /** The WSDL document last imported, kept so operations can be re-chosen offline. */
    wsdl: string;
    /** The selected WSDL operation (`Service.Port.operation` is not needed; the name suffices). */
    operation: string;
}

export const createSoapConfig = (): SoapConfig => ({
    version: '1.1',
    action: '',
    headerXml: '',
    wsdlUrl: '',
    wsdl: '',
    operation: '',
});

/** One operation described by a WSDL document. */
export interface WsdlOperation {
    name: string;
    /** `Binding.operation`, unique across bindings. */
    id: string;
    soapAction: string;
    version: SoapVersion;
    /** Endpoint of the port that exposes this binding, when the WSDL has a service element. */
    endpoint: string;
    /** Skeleton of the `<Body>` content for the operation's input. */
    sampleBody: string;
    documentation: string;
}

export interface WsdlDescription {
    targetNamespace: string;
    operations: WsdlOperation[];
}
