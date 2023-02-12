// Original file: proto/services.proto

import type * as grpc from "@grpc/grpc-js";
import type { MethodDefinition } from "@grpc/proto-loader";
import type {
  GetMockReq as _services_GetMockReq,
  GetMockReq__Output as _services_GetMockReq__Output,
} from "../services/GetMockReq";
import type {
  PutMockReq as _services_PutMockReq,
  PutMockReq__Output as _services_PutMockReq__Output,
} from "../services/PutMockReq";
import type {
  PutMockResp as _services_PutMockResp,
  PutMockResp__Output as _services_PutMockResp__Output,
} from "../services/PutMockResp";
import type {
  StartMockReq as _services_StartMockReq,
  StartMockReq__Output as _services_StartMockReq__Output,
} from "../services/StartMockReq";
import type {
  StartMockResp as _services_StartMockResp,
  StartMockResp__Output as _services_StartMockResp__Output,
} from "../services/StartMockResp";
import type {
  TestCase as _services_TestCase,
  TestCase__Output as _services_TestCase__Output,
} from "../services/TestCase";
import type {
  TestCaseReq as _services_TestCaseReq,
  TestCaseReq__Output as _services_TestCaseReq__Output,
} from "../services/TestCaseReq";
import type {
  TestReq as _services_TestReq,
  TestReq__Output as _services_TestReq__Output,
} from "../services/TestReq";
import type {
  deNoiseResponse as _services_deNoiseResponse,
  deNoiseResponse__Output as _services_deNoiseResponse__Output,
} from "../services/deNoiseResponse";
import type {
  endRequest as _services_endRequest,
  endRequest__Output as _services_endRequest__Output,
} from "../services/endRequest";
import type {
  endResponse as _services_endResponse,
  endResponse__Output as _services_endResponse__Output,
} from "../services/endResponse";
import type {
  getMockResp as _services_getMockResp,
  getMockResp__Output as _services_getMockResp__Output,
} from "../services/getMockResp";
import type {
  getTCRequest as _services_getTCRequest,
  getTCRequest__Output as _services_getTCRequest__Output,
} from "../services/getTCRequest";
import type {
  getTCSRequest as _services_getTCSRequest,
  getTCSRequest__Output as _services_getTCSRequest__Output,
} from "../services/getTCSRequest";
import type {
  getTCSResponse as _services_getTCSResponse,
  getTCSResponse__Output as _services_getTCSResponse__Output,
} from "../services/getTCSResponse";
import type {
  postTCResponse as _services_postTCResponse,
  postTCResponse__Output as _services_postTCResponse__Output,
} from "../services/postTCResponse";
import type {
  startRequest as _services_startRequest,
  startRequest__Output as _services_startRequest__Output,
} from "../services/startRequest";
import type {
  startResponse as _services_startResponse,
  startResponse__Output as _services_startResponse__Output,
} from "../services/startResponse";
import type {
  testResponse as _services_testResponse,
  testResponse__Output as _services_testResponse__Output,
} from "../services/testResponse";

export interface RegressionServiceClient extends grpc.Client {
  DeNoise(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  DeNoise(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  DeNoise(
    argument: _services_TestReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  DeNoise(
    argument: _services_TestReq,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  deNoise(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  deNoise(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  deNoise(
    argument: _services_TestReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;
  deNoise(
    argument: _services_TestReq,
    callback: grpc.requestCallback<_services_deNoiseResponse__Output>
  ): grpc.ClientUnaryCall;

  End(
    argument: _services_endRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  End(
    argument: _services_endRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  End(
    argument: _services_endRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  End(
    argument: _services_endRequest,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  end(
    argument: _services_endRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  end(
    argument: _services_endRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  end(
    argument: _services_endRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;
  end(
    argument: _services_endRequest,
    callback: grpc.requestCallback<_services_endResponse__Output>
  ): grpc.ClientUnaryCall;

  GetMocks(
    argument: _services_GetMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  GetMocks(
    argument: _services_GetMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  GetMocks(
    argument: _services_GetMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  GetMocks(
    argument: _services_GetMockReq,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  getMocks(
    argument: _services_GetMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  getMocks(
    argument: _services_GetMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  getMocks(
    argument: _services_GetMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;
  getMocks(
    argument: _services_GetMockReq,
    callback: grpc.requestCallback<_services_getMockResp__Output>
  ): grpc.ClientUnaryCall;

  GetTC(
    argument: _services_getTCRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  GetTC(
    argument: _services_getTCRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  GetTC(
    argument: _services_getTCRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  GetTC(
    argument: _services_getTCRequest,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  getTc(
    argument: _services_getTCRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  getTc(
    argument: _services_getTCRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  getTc(
    argument: _services_getTCRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;
  getTc(
    argument: _services_getTCRequest,
    callback: grpc.requestCallback<_services_TestCase__Output>
  ): grpc.ClientUnaryCall;

  GetTCS(
    argument: _services_getTCSRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  GetTCS(
    argument: _services_getTCSRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  GetTCS(
    argument: _services_getTCSRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  GetTCS(
    argument: _services_getTCSRequest,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  getTcs(
    argument: _services_getTCSRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  getTcs(
    argument: _services_getTCSRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  getTcs(
    argument: _services_getTCSRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;
  getTcs(
    argument: _services_getTCSRequest,
    callback: grpc.requestCallback<_services_getTCSResponse__Output>
  ): grpc.ClientUnaryCall;

  PostTC(
    argument: _services_TestCaseReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  PostTC(
    argument: _services_TestCaseReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  PostTC(
    argument: _services_TestCaseReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  PostTC(
    argument: _services_TestCaseReq,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  postTc(
    argument: _services_TestCaseReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  postTc(
    argument: _services_TestCaseReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  postTc(
    argument: _services_TestCaseReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;
  postTc(
    argument: _services_TestCaseReq,
    callback: grpc.requestCallback<_services_postTCResponse__Output>
  ): grpc.ClientUnaryCall;

  PutMock(
    argument: _services_PutMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  PutMock(
    argument: _services_PutMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  PutMock(
    argument: _services_PutMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  PutMock(
    argument: _services_PutMockReq,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  putMock(
    argument: _services_PutMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  putMock(
    argument: _services_PutMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  putMock(
    argument: _services_PutMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;
  putMock(
    argument: _services_PutMockReq,
    callback: grpc.requestCallback<_services_PutMockResp__Output>
  ): grpc.ClientUnaryCall;

  Start(
    argument: _services_startRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  Start(
    argument: _services_startRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  Start(
    argument: _services_startRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  Start(
    argument: _services_startRequest,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  start(
    argument: _services_startRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  start(
    argument: _services_startRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  start(
    argument: _services_startRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;
  start(
    argument: _services_startRequest,
    callback: grpc.requestCallback<_services_startResponse__Output>
  ): grpc.ClientUnaryCall;

  StartMocking(
    argument: _services_StartMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  StartMocking(
    argument: _services_StartMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  StartMocking(
    argument: _services_StartMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  StartMocking(
    argument: _services_StartMockReq,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  startMocking(
    argument: _services_StartMockReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  startMocking(
    argument: _services_StartMockReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  startMocking(
    argument: _services_StartMockReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;
  startMocking(
    argument: _services_StartMockReq,
    callback: grpc.requestCallback<_services_StartMockResp__Output>
  ): grpc.ClientUnaryCall;

  Test(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  Test(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  Test(
    argument: _services_TestReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  Test(
    argument: _services_TestReq,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  test(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  test(
    argument: _services_TestReq,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  test(
    argument: _services_TestReq,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
  test(
    argument: _services_TestReq,
    callback: grpc.requestCallback<_services_testResponse__Output>
  ): grpc.ClientUnaryCall;
}

export interface RegressionServiceHandlers
  extends grpc.UntypedServiceImplementation {
  DeNoise: grpc.handleUnaryCall<
    _services_TestReq__Output,
    _services_deNoiseResponse
  >;

  End: grpc.handleUnaryCall<
    _services_endRequest__Output,
    _services_endResponse
  >;

  GetMocks: grpc.handleUnaryCall<
    _services_GetMockReq__Output,
    _services_getMockResp
  >;

  GetTC: grpc.handleUnaryCall<
    _services_getTCRequest__Output,
    _services_TestCase
  >;

  GetTCS: grpc.handleUnaryCall<
    _services_getTCSRequest__Output,
    _services_getTCSResponse
  >;

  PostTC: grpc.handleUnaryCall<
    _services_TestCaseReq__Output,
    _services_postTCResponse
  >;

  PutMock: grpc.handleUnaryCall<
    _services_PutMockReq__Output,
    _services_PutMockResp
  >;

  Start: grpc.handleUnaryCall<
    _services_startRequest__Output,
    _services_startResponse
  >;

  StartMocking: grpc.handleUnaryCall<
    _services_StartMockReq__Output,
    _services_StartMockResp
  >;

  Test: grpc.handleUnaryCall<_services_TestReq__Output, _services_testResponse>;
}

export interface RegressionServiceDefinition extends grpc.ServiceDefinition {
  DeNoise: MethodDefinition<
    _services_TestReq,
    _services_deNoiseResponse,
    _services_TestReq__Output,
    _services_deNoiseResponse__Output
  >;
  End: MethodDefinition<
    _services_endRequest,
    _services_endResponse,
    _services_endRequest__Output,
    _services_endResponse__Output
  >;
  GetMocks: MethodDefinition<
    _services_GetMockReq,
    _services_getMockResp,
    _services_GetMockReq__Output,
    _services_getMockResp__Output
  >;
  GetTC: MethodDefinition<
    _services_getTCRequest,
    _services_TestCase,
    _services_getTCRequest__Output,
    _services_TestCase__Output
  >;
  GetTCS: MethodDefinition<
    _services_getTCSRequest,
    _services_getTCSResponse,
    _services_getTCSRequest__Output,
    _services_getTCSResponse__Output
  >;
  PostTC: MethodDefinition<
    _services_TestCaseReq,
    _services_postTCResponse,
    _services_TestCaseReq__Output,
    _services_postTCResponse__Output
  >;
  PutMock: MethodDefinition<
    _services_PutMockReq,
    _services_PutMockResp,
    _services_PutMockReq__Output,
    _services_PutMockResp__Output
  >;
  Start: MethodDefinition<
    _services_startRequest,
    _services_startResponse,
    _services_startRequest__Output,
    _services_startResponse__Output
  >;
  StartMocking: MethodDefinition<
    _services_StartMockReq,
    _services_StartMockResp,
    _services_StartMockReq__Output,
    _services_StartMockResp__Output
  >;
  Test: MethodDefinition<
    _services_TestReq,
    _services_testResponse,
    _services_TestReq__Output,
    _services_testResponse__Output
  >;
}
