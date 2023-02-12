// Original file: proto/services.proto

import type { Long } from '@grpc/proto-loader';

export interface SqlCol {
  'Name'?: (string);
  'Type'?: (string);
  'Precision'?: (number | string | Long);
  'Scale'?: (number | string | Long);
}

export interface SqlCol__Output {
  'Name'?: (string);
  'Type'?: (string);
  'Precision'?: (Long);
  'Scale'?: (Long);
}
