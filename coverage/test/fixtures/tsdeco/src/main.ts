import { PriceService } from './svc';
import * as http from 'http';

const svc = new PriceService();

export function handle(path: string): string {
  if (path === '/q') {
    return String(svc.quote(21));
  }
  return 'no';
}

http.createServer((req, res) => res.end(handle(req.url || ''))).listen(0);
