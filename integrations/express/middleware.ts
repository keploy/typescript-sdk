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

// got package identifies header fields to identify request and response therefore, request headers
// should not contain header fields (like: content-length, connection)
export function getRequestHeader(headers: http.IncomingHttpHeaders) {
  const result: { [key: string]: string[] } = {};
  for (const key in headers) {
    let val = new Array<string>();
    if (
      key.toLowerCase() === "content-length" ||
      key.toLowerCase() === "connection"
    ) {
      continue;
    }
    if (typeof headers[key] === typeof "s") {
      val.push(headers[key] as string);
    } else if (typeof headers[key] === typeof ["s"]) {
      val = headers[key] as string[];
    }
    result[key] = val;
  }
  return result;
}

export function getResponseHeader(header: http.OutgoingHttpHeaders) {
  const result: { [key: string]: string[] } = {};
  for (const key in header) {
    let val = new Array<string>();
    if (typeof header[key] === typeof "s" || typeof header[key] === typeof 1) {
      val.push(header[key] as string);
    } else if (typeof header[key] === typeof ["s"]) {
      val = header[key] as string[];
    }
    result[key] = val;
  }
  return result;
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
      const response = captureResp(res, next);
      const respHeader: { [key: string]: string[] } = getResponseHeader(
        res.getHeaders()
      );
      const resp = {
        status_code: response.code,
        header: respHeader,
        body: String(response.body),
      };
      keploy.putResp(id, resp);
      return;
    }

    // record mode
    const ctx = new Context("record");
    Context.set(req, ctx);
    const response = captureResp(res, next);

    // req.headers
    const reqHeader: { [key: string]: string[] } = getRequestHeader(
      req.headers
    );

    // response headers
    const respHeader: { [key: string]: string[] } = getResponseHeader(
      res.getHeaders()
    );

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
        status_code: response.code,
        header: respHeader,
        body: String(response.body),
      },
    });
  };
}

function captureResp(res: express.Response, next: express.NextFunction) {
  const oldSend = res.send;

  const chunks = [] as object[];

  res.send = (chunk: object) => {
    chunks.push(chunk);
    return oldSend.apply(res, [chunk]);
  };

  const status = res.status;
  let status_code: number = res.statusCode;
  res.status = (code) => {
    status_code = code;
    return status.apply(res, [code]);
  };

  next();
  return { code: status_code, body: chunks };
}
