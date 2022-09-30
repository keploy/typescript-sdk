// Original file: proto/services.proto

import type { StrArr as _services_StrArr, StrArr__Output as _services_StrArr__Output } from '../services/StrArr';
import type { Long } from '@grpc/proto-loader';

export interface HttpReq {
  'Method'?: (string);
  'ProtoMajor'?: (number | string | Long);
  'ProtoMinor'?: (number | string | Long);
  'URL'?: (string);
  'URLParams'?: ({[key: string]: string});
  'Header'?: ({[key: string]: _services_StrArr});
  'Body'?: (string);
}

export interface HttpReq__Output {
  'Method'?: (string);
  'ProtoMajor'?: (Long);
  'ProtoMinor'?: (Long);
  'URL'?: (string);
  'URLParams'?: ({[key: string]: string});
  'Header'?: ({[key: string]: _services_StrArr__Output});
  'Body'?: (string);
}
