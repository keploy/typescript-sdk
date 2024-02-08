// Original file: proto/services.proto

import type { TestCase as _services_TestCase, TestCase__Output as _services_TestCase__Output } from '../services/TestCase';

export interface getTCSResponse {
  'tcs'?: (_services_TestCase)[];
  'eof'?: (boolean);
}

export interface getTCSResponse__Output {
  'tcs'?: (_services_TestCase__Output)[];
  'eof'?: (boolean);
}
