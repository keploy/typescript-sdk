// Original file: proto/services.proto

import type { Mock as _services_Mock, Mock__Output as _services_Mock__Output } from '../services/Mock';

export interface PutMockReq {
  'Mock'?: (_services_Mock | null);
  'Path'?: (string);
  'Remove'?: (string)[];
  'Replace'?: ({[key: string]: string});
}

export interface PutMockReq__Output {
  'Mock'?: (_services_Mock__Output);
  'Path'?: (string);
  'Remove'?: (string)[];
  'Replace'?: ({[key: string]: string});
}
