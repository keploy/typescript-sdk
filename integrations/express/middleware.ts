/* eslint-disable @typescript-eslint/no-explicit-any */
import express from "express";
import Keploy, { HTTP } from "../../src/keploy";
import { Request, Response, NextFunction } from "express";
import { createExecutionContext, getExecutionContext } from "../../src/context";
import { StrArr } from "../../proto/services/StrArr";

class ResponseBody {
  static responseMap = new WeakMap<Request, ResponseBody>();

  public body: object[];

  constructor() {
    this.body = [];
  }

  static push(req: Request, chunks: object): void {
    const resp = ResponseBody.responseMap.get(req);
    if (resp === undefined || resp.body === undefined) {
      const resp = new ResponseBody();
      resp.body = [chunks];
      ResponseBody.responseMap.set(req, resp);

      return;
    }
    resp.body.push(chunks);
    ResponseBody.responseMap.set(req, resp);
  }
  static get(req: Request): object[] | undefined {
    const ctx = ResponseBody.responseMap.get(req);
    return ctx?.body;
  }
}

// got package identifies header fields to identify request and response therefore, request headers
// should not contain header fields (like: content-length, connection)
export function getRequestHeader(headers: any) {
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

export function getResponseHeader(header: any) {
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
      createExecutionContext({ mode: "off" });
      next();
      return;
    }

    const id = req.get("KEPLOY_TEST_ID");
    // test mode
    if (id != undefined && id != "") {
      createExecutionContext({
        mode: "test",
        testId: id,
        deps: keploy.getDependencies(id),
        mocks: keploy.getMocks(id),
      });
      captureResp(req, res, next);
      return;
    }

    // record mode
    createExecutionContext({ mode: "record", deps: [], mocks: [] });
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
    ResponseBody.push(req, chunk);
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
      body: String(ResponseBody.get(req)),
    };
    keploy.putResp(id, resp);
    return;
  }

  //to avoid recording tests in the test mode and only recording in the record mode
  if (process.env.KEPLOY_MODE == "test" && id === undefined) {
    return;
  }

  // req.headers
  // Since, JSON.stingify trims spaces. Therefore, content-length of request header should be updated
  req.headers["content-length"] = JSON.stringify(
    JSON.stringify(req.body).length
  );
  const reqHeader: { [key: string]: StrArr } = getRequestHeader(req.headers);

  // response headers
  const respHeader: { [key: string]: StrArr } = getResponseHeader(
    res.getHeaders()
  );

  // eslint-disable-next-line prefer-const
  let kctx = getExecutionContext(),
    deps = undefined,
    mocks = undefined;
  if (kctx !== undefined && kctx.context !== undefined) {
    deps = kctx.context.deps;
    mocks = kctx.context.mocks;
  }

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
      Body: String(ResponseBody.get(req)),
    },
    Dependency: deps,
    TestCasePath: keploy.appConfig.testCasePath,
    MockPath: keploy.appConfig.mockPath,
    Mocks: mocks,
    Type: HTTP,
  });
}
