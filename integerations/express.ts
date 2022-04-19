import express from "express";
import Keploy from "../src/keploy";
import { Request, Response, NextFunction } from "express";

type Dependency = {
  name: string;
  type: string;
  meta: object;
  data: object[];
};

type KeployContext = {
  mode: string | undefined;
  testId: string | undefined;
  deps: Dependency[] | undefined;
};

class Context {
  static _bindings = new WeakMap<Request, Context>();

  public keployContext: KeployContext;

  constructor(mode?: string, testId?: string, deps?: Dependency[]) {
    this.keployContext = {
      mode,
      testId,
      deps,
    };
  }
  // bind sets an empty Context for req as a key in _bindings.
  static bind(req: Request): void {
    const ctx = new Context();
    Context._bindings.set(req, ctx);
  }
  // get returns the value of Context stored for the req key. It returns null if req key is not present
  static get(req: Request): Context | null {
    return Context._bindings.get(req) || null;
  }
  // set is used to make a key-value pair for the  req and ctx
  static set(req: Request, ctx: Context): void {
    Context._bindings.set(req, ctx);
  }
}

// middleware
export default function middleware(
  keploy: Keploy
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      (process.env.KEPLOY_MODE != undefined &&
        process.env.KEPLOY_MODE == "off") ||
      keploy == undefined
    ) {
      next();
      return;
    }

    const id = req.get("KEPLOY_TEST_ID");
    // test mode
    if (id != undefined && id != "") {
      const ctx = new Context("test", id, []);
      Context.set(req, ctx);
      const data = captureResp(res, next);
      const resp = {
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: data,
      };
      keploy.putResp(id, resp);
      return;
    }

    // record mode
    const ctx = new Context("record");
    Context.set(req, ctx);
    const data = captureResp(res, next);

    keploy.capture({
      captured: Date.now(),
      appId: keploy.appConfig.name,
      uri: req.url,
      httpReq: {
        Method: req.method,
        URL: req.url,
        URLParams: req.params,
        Header: req.headers,
        Body: req.body,
      },
      httpRes: {
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: data,
      },
    });
  };
}

function captureResp(res: express.Response, next: express.NextFunction) {
  // const oldWrite = res.write
  // const oldEnd = res.end;
  const oldSend = res.send;

  const chunks = [] as object[];

  res.send = (chunk: object) => {
    chunks.push(chunk);
    return oldSend.apply(res, [chunk]);
  };
  next();
  return chunks;

  // res.write = (chunk:any, cb?: ((error: Error | null | undefined) => void) | undefined) => {
  // chunks.push(chunk);
  // return oldWrite.apply(res, [chunk, cb]);
  // };

  // res.end = (chunk, ...args) => {
  //     if (chunk) {
  //         chunks.push(chunk);
  //     }
  //     const body = Buffer.concat(chunks).toString('utf8');
  //     console.log(req.path, body);
  //     return oldEnd.apply(res, [chunk, ...args]);
  // };
}
