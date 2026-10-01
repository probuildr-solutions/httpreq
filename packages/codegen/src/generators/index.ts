/*
 * Copyright (c) 2026 Yamatri Reddy
 * SPDX-License-Identifier: GPL-3.0-only
 */

import type { CodeGenerator, CodegenRequest } from '@httpreq/shared';
import { csharpHttpClientGenerator } from './http/dotnet/httpclient';
import { goNetHttpGenerator } from './http/go/nethttp';
import { javaHttpClientGenerator } from './http/java/httpclient';
import { javaOkHttpGenerator } from './http/java/okhttp';
import { axiosGenerator } from './http/javascript/axios';
import { javascriptFetchGenerator, typescriptFetchGenerator } from './http/javascript/fetch';
import { phpCurlGenerator } from './http/php/curl';
import { powershellGenerator } from './http/powershell/invoke-restmethod';
import { pythonRequestsGenerator } from './http/python/requests';
import { rubyNetHttpGenerator } from './http/ruby/nethttp';
import { curlGenerator } from './http/shell/curl';
import { swiftUrlSessionGenerator } from './http/swift/urlsession';
import { grpcurlGenerator } from './grpc/grpcurl';
import { nodeGrpcGenerator } from './grpc/node-grpc';
import { mosquittoGenerator } from './mqtt/mosquitto';
import { nodeMqttGenerator } from './mqtt/node-mqtt';
import { pythonPahoGenerator } from './mqtt/python-paho';

/**
 * Every generator the app ships with, in the order the selector lists them. This is the single
 * place a new target is registered: write its generator, import it, add it here.
 */
export const DEFAULT_GENERATORS: readonly CodeGenerator<CodegenRequest>[] = [
    curlGenerator,
    javascriptFetchGenerator,
    typescriptFetchGenerator,
    axiosGenerator,
    pythonRequestsGenerator,
    javaHttpClientGenerator,
    javaOkHttpGenerator,
    csharpHttpClientGenerator,
    goNetHttpGenerator,
    phpCurlGenerator,
    rubyNetHttpGenerator,
    swiftUrlSessionGenerator,
    powershellGenerator,
    grpcurlGenerator,
    nodeGrpcGenerator,
    mosquittoGenerator,
    nodeMqttGenerator,
    pythonPahoGenerator,
];
