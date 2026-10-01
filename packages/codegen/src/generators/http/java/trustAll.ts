/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeWriter } from '../../../core/writer';

/** Imports `writeTrustAll` needs. */
export const TRUST_ALL_IMPORTS = [
    'java.security.SecureRandom',
    'java.security.cert.X509Certificate',
    'javax.net.ssl.SSLContext',
    'javax.net.ssl.TrustManager',
    'javax.net.ssl.X509TrustManager',
] as const;

/**
 * Declares `trustAll` (an `X509TrustManager` that accepts every certificate) and an `sslContext`
 * that uses it, for a request whose certificate verification is switched off. Shared by the Java
 * targets, which differ only in how they hand the context to their client.
 */
export const writeTrustAll = (out: CodeWriter): void => {
    out.line('// Certificate verification is off for this request.');
    out.block('X509TrustManager trustAll = new X509TrustManager() {', '};', () => {
        out.line('@Override');
        out.line('public void checkClientTrusted(X509Certificate[] chain, String authType) {}');
        out.blank();
        out.line('@Override');
        out.line('public void checkServerTrusted(X509Certificate[] chain, String authType) {}');
        out.blank();
        out.line('@Override');
        out.block('public X509Certificate[] getAcceptedIssuers() {', '}', () =>
            out.line('return new X509Certificate[0];'),
        );
    });
    out.line('SSLContext sslContext = SSLContext.getInstance("TLS");');
    out.line('sslContext.init(null, new TrustManager[] {trustAll}, new SecureRandom());');
    out.blank();
};
