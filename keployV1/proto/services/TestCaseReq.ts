// Original file: proto/services.proto

import type {
  HttpReq as _services_HttpReq,
  HttpReq__Output as _services_HttpReq__Output,
} from "../services/HttpReq";
import type {
  HttpResp as _services_HttpResp,
  HttpResp__Output as _services_HttpResp__Output,
} from "../services/HttpResp";
import type {
  Dependency as _services_Dependency,
  Dependency__Output as _services_Dependency__Output,
} from "../services/Dependency";
import type {
  Mock as _services_Mock,
  Mock__Output as _services_Mock__Output,
} from "../services/Mock";
import type {
  GrpcReq as _services_GrpcReq,
  GrpcReq__Output as _services_GrpcReq__Output,
} from "../services/GrpcReq";
import type {
  GrpcResp as _services_GrpcResp,
  GrpcResp__Output as _services_GrpcResp__Output,
} from "../services/GrpcResp";
import type { Long } from "@grpc/proto-loader";

export interface TestCaseReq {
  Captured?: number | string | Long;
  AppID?: string;
  URI?: string;
  HttpReq?: _services_HttpReq | null;
  HttpResp?: _services_HttpResp | null;
  Dependency?: _services_Dependency[];
  TestCasePath?: string;
  MockPath?: string;
  Mocks?: _services_Mock[];
  Remove?: string[];
  Replace?: { [key: string]: string };
  Type?: string;
  GrpcReq?: _services_GrpcReq | null;
  GrpcResp?: _services_GrpcResp | null;
}

export interface TestCaseReq__Output {
  Captured?: Long;
  AppID?: string;
  URI?: string;
  HttpReq?: _services_HttpReq__Output;
  HttpResp?: _services_HttpResp__Output;
  Dependency?: _services_Dependency__Output[];
  TestCasePath?: string;
  MockPath?: string;
  Mocks?: _services_Mock__Output[];
  Remove?: string[];
  Replace?: { [key: string]: string };
  Type?: string;
  GrpcReq?: _services_GrpcReq__Output;
  GrpcResp?: _services_GrpcResp__Output;
}
