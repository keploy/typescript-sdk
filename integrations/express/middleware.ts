import express from "express";
import Keploy from "../../src/keploy";
import { Request, Response, NextFunction } from "express";
import http = require("http");
import { createExecutionContext, getExecutionContext } from "../../src/context";
import { StrArr } from "../../proto/services/StrArr";

type Dependency = {
  name: string;
  type: string;
  meta: object;
  data: object[];
};

type KeployContext = {
  mode: string | undefined;
  testId: string | undefined;
  deps: object[] | undefined;
};

class Context {
  static _bindings = new WeakMap<Request, Context>();
  static _response = new WeakMap<Request, Context>();

  public keployContext: KeployContext;
  public responseBody: object[];

  constructor(mode?: string, testId?: string, deps?: object[]) {
    this.keployContext = {
      mode,
      testId,
      deps,
    };
    this.responseBody = [];
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
    Context._response.set(req, ctx);
  }

  static pushResponse(req: Request, chunks: object): void {
    const ctx = Context._response.get(req);
    const oldResponse = ctx?.responseBody;
    if (oldResponse === undefined || ctx == undefined) {
      return;
    }
    oldResponse.push(chunks);
    Context._response.set(req, ctx);
  }
  static getResponse(req: Request): object[] | undefined {
    const ctx = Context._response.get(req);
    return ctx?.responseBody;
  }
}

// got package identifies header fields to identify request and response therefore, request headers
// should not contain header fields (like: content-length, connection)
export function getRequestHeader(headers: http.IncomingHttpHeaders) {
  const result: { [key: string]: StrArr } = {};
  for (const key in headers) {
    let val = new Array<string>();
    if (typeof headers[key] === typeof "s") {
      val.push(headers[key] as string);
    } else if (typeof headers[key] === typeof ["s"]) {
      val = headers[key] as string[];
    }
    result[key] = { Value: val };
  }
  return result;
}

export function getResponseHeader(header: http.OutgoingHttpHeaders) {
  const result: { [key: string]: StrArr } = {};
  for (const key in header) {
    let val = new Array<string>();
    if (typeof header[key] === typeof "s" || typeof header[key] === typeof 1) {
      val.push(header[key] as string);
    } else if (typeof header[key] === typeof ["s"]) {
      val = header[key] as string[];
    }
    result[key] = { Value: val };
  }
  return result;
}

// middleware
export default function middleware(
  keploy: Keploy
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction) => {
    res.on("finish", () => {
      afterMiddleware(keploy, req, res);
    });
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
      const ctx = new Context("test", id, keploy.getDependencies(id));
      Context.set(req, ctx);
      createExecutionContext(ctx);
      captureResp(req, res, next);
      return;
    }

    // record mode
    const ctx = new Context("record", undefined, []);
    Context.set(req, ctx);
    createExecutionContext(ctx);
    captureResp(req, res, next);
  };
}

function captureResp(
  req: Request,
  res: express.Response,
  next: express.NextFunction
) {
  const oldSend = res.send;

  res.send = (chunk: object) => {
    Context.pushResponse(req, chunk);
    return oldSend.apply(res, [chunk]);
  };

  next();
  return;
}

export function afterMiddleware(keploy: Keploy, req: Request, res: Response) {
  if (
    (process.env.KEPLOY_MODE != undefined &&
      process.env.KEPLOY_MODE == "off") ||
    keploy == undefined
  ) {
    return;
  }

  const id = req.get("KEPLOY_TEST_ID");
  if (id !== undefined && id !== "") {
    const respHeader: { [key: string]: StrArr } = getResponseHeader(
      res.getHeaders()
    );
    const resp = {
      status_code: res.statusCode,
      header: respHeader,
      // @ts-ignore
      body: String(Context.getResponse(req)),
    };
    keploy.putResp(id, resp);
    return;
  }

  // req.headers
  const reqHeader: { [key: string]: StrArr } = getRequestHeader(req.headers);

  // response headers
  const respHeader: { [key: string]: StrArr } = getResponseHeader(
    res.getHeaders()
  );

  keploy.capture({
    Captured: Date.now(),
    AppID: keploy.appConfig.name,
    // change url to uri ex: /url-shortner/:param
    URI: req.originalUrl,
    HttpReq: {
      Method: req.method,
      URL: req.originalUrl,
      URLParams: req.params,
      Header: reqHeader,
      Body: JSON.stringify(req.body),
    },
    HttpResp: {
      StatusCode: res.statusCode,
      Header: respHeader,
      // @ts-ignore
      Body: String(Context.getResponse(req)),
    },
    Dependency: getExecutionContext().context.keployContext.deps,
    TestCasePath: keploy.appConfig.testCasePath,
    MockPath: keploy.appConfig.mockPath,
  });
}
