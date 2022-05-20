import express from "express";
import Keploy from "../../src/keploy";
import { Request, Response, NextFunction } from "express";
import http = require("http");

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
  keployFn: () => Keploy
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    const keploy = keployFn();
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
    //const a = new Map(Object.entries(req.headers));
    // req.headers
    const map: { [key: string]: string[] } = {};
    for (const key in req.headers) {
      let val = new Array<string>();
      if (typeof req.headers[key] === typeof "s") {
        val.push(req.headers[key] as string);
      } else if (typeof req.headers[key] === typeof ["s"]) {
        val = req.headers[key] as string[];
      }
      map[key] = val;
    }
    console.log(map);

    // req.headers
    const reqHeader: { [key: string]: string[] } = {};
    for (const key in req.headers) {
      let val = new Array<string>();
      if (typeof req.headers[key] === typeof "s") {
        val.push(req.headers[key] as string);
      } else if (typeof req.headers[key] === typeof ["s"]) {
        val = req.headers[key] as string[];
      }
      reqHeader[key] = val;
    }
    // response headers
    const respHeader: { [key: string]: string[] } = {};
    const header = res.getHeaders();
    for (const key in header) {
      let val = new Array<string>();
      if (typeof header[key] === typeof "s") {
        val.push(header[key] as string);
      } else if (typeof header[key] === typeof ["s"]) {
        val = header[key] as string[];
      }
      respHeader[key] = val;
    }

    keploy.capture({
      captured: Date.now(),
      appId: keploy.appConfig.name,
      uri: req.url,
      httpReq: {
        method: req.method,
        url: req.url,
        url_params: req.params,
        header: reqHeader,
        body: JSON.stringify(req.body),
      },
      httpResp: {
        status_code: res.statusCode,
        header: respHeader,
        body: String(data),
      },
    });
    console.log(map);
  };
}

function captureResp(res: express.Response, next: express.NextFunction) {
  const oldSend = res.send;

  const chunks = [] as object[];

  res.send = (chunk: object) => {
    chunks.push(chunk);
    return oldSend.apply(res, [chunk]);
  };
  next();
  return chunks;
}
