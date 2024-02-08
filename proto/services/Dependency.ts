// Original file: proto/services.proto

import type { DataBytes as _services_DataBytes, DataBytes__Output as _services_DataBytes__Output } from '../services/DataBytes';

export interface Dependency {
  'Name'?: (string);
  'Type'?: (string);
  'Meta'?: ({[key: string]: string});
  'Data'?: (_services_DataBytes)[];
}

export interface Dependency__Output {
  'Name'?: (string);
  'Type'?: (string);
  'Meta'?: ({[key: string]: string});
  'Data'?: (_services_DataBytes__Output)[];
}
