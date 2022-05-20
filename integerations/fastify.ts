//import fastify from "fastify";
import plugin from "@fastify/express";
import Keploy from "../src/keploy";
import fastify, { FastifyRequest, FastifyReply } from "fastify";
import { P } from "pino";
import * as core from "express-serve-static-core";
import { NextFunction } from "express";
const server = fastify();

(async () => {
  await server.register(plugin);
})();
server.use(require("cors")());

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
  static _bindings = new WeakMap<FastifyRequest, Context>();
  public keployContext: KeployContext;

  constructor(mode?: string, testId?: string, deps?: Dependency[]) {
    this.keployContext = {
      mode,
      testId,
      deps,
    };
  }

  static bind(req: FastifyRequest): void {
    const ctx = new Context();
    Context._bindings.set(req, ctx);
  }
  static get(req: FastifyRequest): Context | null {
    return Context._bindings.get(req) || null;
  }

  static set(req: FastifyRequest, ctx: Context): void {
    Context._bindings.set(req, ctx);
  }
}

export default function middleware(
  keploy: Keploy
): (req: FastifyRequest, res: FastifyReply, next: NextFunction) => void {
  return (req: FastifyRequest, res: FastifyReply, next: NextFunction) => {
    if (
      (process.env.KEPLOY_MODE != undefined &&
        process.env.KEPLOY_MODE == "off") ||
      keploy == undefined
    ) {
      server.use(next());
      return;
    }
    const id = req.get("KEPLOY_TEST_ID");
    if (id != undefined && id != "") {
      const ctx = new Context("test", id, []);
      const data = captureResp(res, next);
      const resp = {
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: data,
      };
      keploy.putResp(id, resp);
      return;
    }

    const ctx = new Context("record");
    Context.set(req, ctx);
    const data = captureResp(res, next);

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

    //console.log(req.rawHeaders);
    keploy.capture({
      captured: Date.now(),
      appId: keploy.appConfig.name,
      uri: req.url,
      httpReq: {
        Method: req.method,
        URL: req.url,
        URLParams: req.params,
        Header: map,
        Body: String(req.body),
      },
      httpRes: {
        statusCode: res.statusCode,
        headers: res.getHeaders(),
        body: data,
      },
    });
    console.log(map);
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
}
