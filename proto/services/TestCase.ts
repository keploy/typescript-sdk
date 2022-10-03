// Original file: proto/services.proto

import type { HttpReq as _services_HttpReq, HttpReq__Output as _services_HttpReq__Output } from '../services/HttpReq';
import type { HttpResp as _services_HttpResp, HttpResp__Output as _services_HttpResp__Output } from '../services/HttpResp';
import type { Dependency as _services_Dependency, Dependency__Output as _services_Dependency__Output } from '../services/Dependency';
import type { StrArr as _services_StrArr, StrArr__Output as _services_StrArr__Output } from '../services/StrArr';
import type { Mock as _services_Mock, Mock__Output as _services_Mock__Output } from '../services/Mock';
import type { Long } from '@grpc/proto-loader';

export interface TestCase {
  'id'?: (string);
  'created'?: (number | string | Long);
  'updated'?: (number | string | Long);
  'captured'?: (number | string | Long);
  'CID'?: (string);
  'appID'?: (string);
  'URI'?: (string);
  'HttpReq'?: (_services_HttpReq | null);
  'HttpResp'?: (_services_HttpResp | null);
  'Deps'?: (_services_Dependency)[];
  'allKeys'?: ({[key: string]: _services_StrArr});
  'anchors'?: ({[key: string]: _services_StrArr});
  'noise'?: (string)[];
  'Mocks'?: (_services_Mock)[];
}

export interface TestCase__Output {
  'id'?: (string);
  'created'?: (Long);
  'updated'?: (Long);
  'captured'?: (Long);
  'CID'?: (string);
  'appID'?: (string);
  'URI'?: (string);
  'HttpReq'?: (_services_HttpReq__Output);
  'HttpResp'?: (_services_HttpResp__Output);
  'Deps'?: (_services_Dependency__Output)[];
  'allKeys'?: ({[key: string]: _services_StrArr__Output});
  'anchors'?: ({[key: string]: _services_StrArr__Output});
  'noise'?: (string)[];
  'Mocks'?: (_services_Mock__Output)[];
}
