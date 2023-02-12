// Original file: proto/services.proto

import type { SqlCol as _services_SqlCol, SqlCol__Output as _services_SqlCol__Output } from '../services/SqlCol';

export interface Table {
  'Cols'?: (_services_SqlCol)[];
  'Rows'?: (string)[];
}

export interface Table__Output {
  'Cols'?: (_services_SqlCol__Output)[];
  'Rows'?: (string)[];
}
