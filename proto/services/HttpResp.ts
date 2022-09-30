// Original file: proto/services.proto

import type { StrArr as _services_StrArr, StrArr__Output as _services_StrArr__Output } from '../services/StrArr';
import type { Long } from '@grpc/proto-loader';

export interface HttpResp {
  'StatusCode'?: (number | string | Long);
  'Header'?: ({[key: string]: _services_StrArr});
  'Body'?: (string);
}

export interface HttpResp__Output {
  'StatusCode'?: (Long);
  'Header'?: ({[key: string]: _services_StrArr__Output});
  'Body'?: (string);
}
