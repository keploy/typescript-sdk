import express from "express";
import Keploy from "../src/keploy"; 
import{ HttpResponse } from "../src/keploy";
import { Request } from 'express';

type dependency = {
    name: string,
    type: string,
    meta: object,
    data: []
}

type Kctx = {
    mode: string | undefined,
    testId: string | undefined,
    deps: dependency[] | undefined
}

class Context {
  static _bindings = new WeakMap<Request, Context>();

  public kctx: Kctx;

  constructor (mode?: string, testId?: string, deps?: dependency[]) {
    this.kctx= {
        mode,
        testId,
        deps
    }
  }

  static bind (req: Request) : void {
    const ctx = new Context();
    Context._bindings.set(req, ctx);
  }

  static get (req: Request) : Context | null {
    return Context._bindings.get(req) || null;
  }

  static set (req: Request, ctx: Context) : void {
    Context._bindings.set(req, ctx);
  }
}

// how to use Keploy public methods here by getting the instance of class Keploy as parameter
export default function middleware(k: object): (req:express.Request , res:express.Response, next:express.NextFunction)=>void{
    return (req:express.Request , res:express.Response, next:express.NextFunction) => {

        if (process.env.KEPLOY_MODE!=undefined && process.env.KEPLOY_MODE=="off"){
            next()
            return
        }
        const id = req.get("KEPLOY_TEST_ID")
        if (id!=undefined && id!=""){
            let ctx = new Context("test", id, [])
            Context.set(req, ctx)
            let data = captureResp(res,next)
            const resp: HttpResponse = {
                statusCode: res.statusCode,
                headers: res.getHeaders(),
                body: data
            }
            
        }
    }
}

function captureResp(res:express.Response, next:express.NextFunction): any[]{
    // const oldWrite = res.write
    // const oldEnd = res.end;
    const oldSend = res.send

    const chunks:any[] = [];

    res.send = function(chunk: any): express.Response {
        chunks.push(chunk)
        return oldSend(chunk)
    }
    next()
    return chunks

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