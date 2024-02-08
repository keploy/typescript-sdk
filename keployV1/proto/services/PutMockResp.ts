// Original file: proto/services.proto

import type { Long } from '@grpc/proto-loader';

export interface PutMockResp {
  'Inserted'?: (number | string | Long);
}

export interface PutMockResp__Output {
  'Inserted'?: (Long);
}
