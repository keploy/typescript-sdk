// Original file: proto/services.proto

import type { StrArr as _services_StrArr, StrArr__Output as _services_StrArr__Output } from '../services/StrArr';
import type { HttpReq as _services_HttpReq, HttpReq__Output as _services_HttpReq__Output } from '../services/HttpReq';
import type { HttpResp as _services_HttpResp, HttpResp__Output as _services_HttpResp__Output } from '../services/HttpResp';
import type { Table as _services_Table, Table__Output as _services_Table__Output } from '../services/Table';
import type { GrpcReq as _services_GrpcReq, GrpcReq__Output as _services_GrpcReq__Output } from '../services/GrpcReq';
import type { GrpcResp as _services_GrpcResp, GrpcResp__Output as _services_GrpcResp__Output } from '../services/GrpcResp';
import type { Long } from '@grpc/proto-loader';

export interface _services_Mock_Object {
  'Type'?: (string);
  'Data'?: (Buffer | Uint8Array | string);
}

export interface _services_Mock_Object__Output {
  'Type'?: (string);
  'Data'?: (Buffer);
}

export interface _services_Mock_Request {
  'Method'?: (string);
  'ProtoMajor'?: (number | string | Long);
  'ProtoMinor'?: (number | string | Long);
  'URL'?: (string);
  'Header'?: ({[key: string]: _services_StrArr});
  'Body'?: (string);
}

export interface _services_Mock_Request__Output {
  'Method'?: (string);
  'ProtoMajor'?: (Long);
  'ProtoMinor'?: (Long);
  'URL'?: (string);
  'Header'?: ({[key: string]: _services_StrArr__Output});
  'Body'?: (string);
}

export interface _services_Mock_SpecSchema {
  'Metadata'?: ({[key: string]: string});
  'Objects'?: (_services_Mock_Object)[];
  'Req'?: (_services_HttpReq | null);
  'Res'?: (_services_HttpResp | null);
  'Mocks'?: (string)[];
  'Assertions'?: ({[key: string]: _services_StrArr});
  'Created'?: (number | string | Long);
  'Type'?: (string);
  'Table'?: (_services_Table | null);
  'Int'?: (number | string | Long);
  'Err'?: (string)[];
  'GrpcRequest'?: (_services_GrpcReq | null);
  'GrpcResp'?: (_services_GrpcResp | null);
  '_Table'?: "Table";
}

export interface _services_Mock_SpecSchema__Output {
  'Metadata'?: ({[key: string]: string});
  'Objects'?: (_services_Mock_Object__Output)[];
  'Req'?: (_services_HttpReq__Output);
  'Res'?: (_services_HttpResp__Output);
  'Mocks'?: (string)[];
  'Assertions'?: ({[key: string]: _services_StrArr__Output});
  'Created'?: (Long);
  'Type'?: (string);
  'Table'?: (_services_Table__Output);
  'Int'?: (Long);
  'Err'?: (string)[];
  'GrpcRequest'?: (_services_GrpcReq__Output);
  'GrpcResp'?: (_services_GrpcResp__Output);
}

export interface Mock {
  'Version'?: (string);
  'Name'?: (string);
  'Kind'?: (string);
  'Spec'?: (_services_Mock_SpecSchema | null);
}

export interface Mock__Output {
  'Version'?: (string);
  'Name'?: (string);
  'Kind'?: (string);
  'Spec'?: (_services_Mock_SpecSchema__Output);
}
