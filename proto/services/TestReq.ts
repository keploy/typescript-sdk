// Original file: proto/services.proto

import type { HttpResp as _services_HttpResp, HttpResp__Output as _services_HttpResp__Output } from '../services/HttpResp';

export interface TestReq {
  'ID'?: (string);
  'AppID'?: (string);
  'RunID'?: (string);
  'Resp'?: (_services_HttpResp | null);
  'TestCasePath'?: (string);
  'MockPath'?: (string);
}

export interface TestReq__Output {
  'ID'?: (string);
  'AppID'?: (string);
  'RunID'?: (string);
  'Resp'?: (_services_HttpResp__Output);
  'TestCasePath'?: (string);
  'MockPath'?: (string);
}
