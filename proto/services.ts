import type * as grpc from "@grpc/grpc-js";
import type { MessageTypeDefinition } from "@grpc/proto-loader";

import type {
  RegressionServiceClient as _services_RegressionServiceClient,
  RegressionServiceDefinition as _services_RegressionServiceDefinition,
} from "./services/RegressionService";

type SubtypeConstructor<
  Constructor extends new (...args: any) => any,
  Subtype
> = {
  new (...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  services: {
    DataBytes: MessageTypeDefinition;
    Dependency: MessageTypeDefinition;
    FormData: MessageTypeDefinition;
    GetMockReq: MessageTypeDefinition;
    GrpcReq: MessageTypeDefinition;
    GrpcResp: MessageTypeDefinition;
    HttpReq: MessageTypeDefinition;
    HttpResp: MessageTypeDefinition;
    Method: MessageTypeDefinition;
    Mock: MessageTypeDefinition;
    PutMockReq: MessageTypeDefinition;
    PutMockResp: MessageTypeDefinition;
    RegressionService: SubtypeConstructor<
      typeof grpc.Client,
      _services_RegressionServiceClient
    > & { service: _services_RegressionServiceDefinition };
    SqlCol: MessageTypeDefinition;
    StartMockReq: MessageTypeDefinition;
    StartMockResp: MessageTypeDefinition;
    StrArr: MessageTypeDefinition;
    Table: MessageTypeDefinition;
    TestCase: MessageTypeDefinition;
    TestCaseReq: MessageTypeDefinition;
    TestReq: MessageTypeDefinition;
    deNoiseResponse: MessageTypeDefinition;
    endRequest: MessageTypeDefinition;
    endResponse: MessageTypeDefinition;
    getMockResp: MessageTypeDefinition;
    getTCRequest: MessageTypeDefinition;
    getTCSRequest: MessageTypeDefinition;
    getTCSResponse: MessageTypeDefinition;
    postTCResponse: MessageTypeDefinition;
    startRequest: MessageTypeDefinition;
    startResponse: MessageTypeDefinition;
    testResponse: MessageTypeDefinition;
  };
}
