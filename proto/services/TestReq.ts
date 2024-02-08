// Original file: proto/services.proto

import type { HttpResp as _services_HttpResp, HttpResp__Output as _services_HttpResp__Output } from '../services/HttpResp';
import type { GrpcResp as _services_GrpcResp, GrpcResp__Output as _services_GrpcResp__Output } from '../services/GrpcResp';

export interface TestReq {
  'ID'?: (string);
  'AppID'?: (string);
  'RunID'?: (string);
  'Resp'?: (_services_HttpResp | null);
  'TestCasePath'?: (string);
  'MockPath'?: (string);
  'Type'?: (string);
  'GrpcResp'?: (_services_GrpcResp | null);
}

export interface TestReq__Output {
  'ID'?: (string);
  'AppID'?: (string);
  'RunID'?: (string);
  'Resp'?: (_services_HttpResp__Output);
  'TestCasePath'?: (string);
  'MockPath'?: (string);
  'Type'?: (string);
  'GrpcResp'?: (_services_GrpcResp__Output);
}
