// Original file: proto/services.proto

import type { StrArr as _services_StrArr, StrArr__Output as _services_StrArr__Output } from '../services/StrArr';
import type { FormData as _services_FormData, FormData__Output as _services_FormData__Output } from '../services/FormData';
import type { Long } from '@grpc/proto-loader';

export interface HttpReq {
  'Method'?: (string);
  'ProtoMajor'?: (number | string | Long);
  'ProtoMinor'?: (number | string | Long);
  'URL'?: (string);
  'URLParams'?: ({[key: string]: string});
  'Header'?: ({[key: string]: _services_StrArr});
  'Body'?: (string);
  'Binary'?: (string);
  'Form'?: (_services_FormData)[];
  'BodyData'?: (Buffer | Uint8Array | string);
}

export interface HttpReq__Output {
  'Method'?: (string);
  'ProtoMajor'?: (Long);
  'ProtoMinor'?: (Long);
  'URL'?: (string);
  'URLParams'?: ({[key: string]: string});
  'Header'?: ({[key: string]: _services_StrArr__Output});
  'Body'?: (string);
  'Binary'?: (string);
  'Form'?: (_services_FormData__Output)[];
  'BodyData'?: (Buffer);
}
