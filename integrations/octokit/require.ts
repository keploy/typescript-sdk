/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
import Hook from "require-in-the-middle";
import mixin from "merge-descriptors";
import fetch, { Headers, Response, ResponseInit } from "node-fetch";
import { getExecutionContext } from "../../src/context";
import { Readable } from "stream";
import { ProcessDep, stringToBinary } from "../../src/util";
import { putMocks } from "../../mock/utils";
import { HTTP_EXPORT, V1_BETA1 } from "../../src/keploy";
import { getRequestHeader, getResponseHeader } from "../express/middleware";
import { getReasonPhrase } from "http-status-codes";
import { DataBytes } from "../../proto/services/DataBytes";

// @ts-ignore
Hook(["octokit"], function (exported) {
  const octokitDefault = exported;

  class WrappedOctokit {
    constructor(props: any) {
      const wrappedFetch = wrappedNodeFetch();

      if (props.request != undefined) {
        props.request.fetch = wrappedFetch;
      } else {
        props.request = {
          fetch: wrappedFetch,
        };
      }
      const octo = new octokitDefault.Octokit(props);
      mixin(this, octo, false);
    }
  }
  const wrappedExports = {
    Octokit: WrappedOctokit,
  };

  exported = mixin(wrappedExports, octokitDefault, false);
  return exported;
});

function getHeadersInit(headers: { [k: string]: string[] }): {
  [k: string]: string;
} {
  const result: { [key: string]: string } = {};
  for (const key in headers) {
    result[key] = headers[key].join(", ");
  }
  return result;
}

export function wrappedNodeFetch() {
  const fetchFunc = fetch;
  async function wrappedFetch(
    this: { fetch: (url: any, options: any) => any },
    url: any,
    options: any
  ) {
    if (
      getExecutionContext() == undefined ||
      getExecutionContext().context == undefined
    ) {
      console.error("keploy context is not present to mock dependencies");
      return;
    }
    const ctx = getExecutionContext().context;
    let resp = new Response();
    let rinit: ResponseInit = {};
    const meta = {
      name: "node-fetch",
      url: url,
      options: options,
      type: "HTTP_CLIENT",
    };
    switch (ctx.mode) {
      case "record":
        resp = await fetchFunc.apply(this, [url, options]);
        const clonedResp = resp.clone();
        rinit = {
          headers: getHeadersInit(clonedResp.headers.raw()),
          status: resp.status,
          statusText: resp.statusText,
        };
        const respData: Buffer[] = [];
        clonedResp?.body?.on("data", function (chunk: Buffer) {
          respData.push(chunk);
        });
        clonedResp?.body?.on("end", async function () {
          const httpMock = {
            Version: V1_BETA1,
            Name: ctx.testId,
            Kind: HTTP_EXPORT,
            Spec: {
              Metadata: meta,
              Req: {
                URL: url,
                Body: JSON.stringify(options?.body),
                Header: getRequestHeader(options.headers),
                Method: options.method,
                // URLParams:
              },
              Res: {
                StatusCode: rinit.status,
                Header: getResponseHeader(rinit.headers),
                Body: respData.toString(),
              },
            },
          };
          // record mocks for unit-test-mock-library
          if (ctx.fileExport === true) {
            putMocks(httpMock);
          } else {
            ctx.mocks.push(httpMock);
            // ProcessDep(meta, [respData, rinit]);
            const res: DataBytes[] = [];
            // for (let i = 0; i < outputs.length; i++) {
            res.push({ Bin: stringToBinary(JSON.stringify(respData)) });
            res.push({ Bin: stringToBinary(JSON.stringify(rinit)) });
            // }
            ctx.deps.push({
              Name: meta.name,
              Type: meta.type,
              Meta: meta,
              Data: res,
            });
          }
        });
        break;
      case "test":
        const outputs = new Array(2);
        if (
          ctx.mocks != undefined &&
          ctx.mocks.length > 0 &&
          ctx.mocks[0].Kind == HTTP_EXPORT
        ) {
          const header: { [key: string]: string[] } = {};
          for (const k in ctx.mocks[0].Spec?.Res?.Header) {
            header[k] = ctx.mocks[0].Spec?.Res?.Header[k]?.Value;
          }
          outputs[1] = {
            headers: getHeadersInit(header),
            status: ctx.mocks[0].Spec.Res.StatusCode,
            statusText: getReasonPhrase(ctx.mocks[0].Spec.Res.StatusCode),
          };
          outputs[0] = [ctx.mocks[0].Spec.Res.Body];
          ctx.mocks.shift();
        } else {
          ProcessDep({}, outputs);
        }
        rinit.headers = new Headers(outputs[1].headers);
        rinit.status = outputs[1].status;
        rinit.statusText = outputs[1].statusText;
        const buf: Buffer[] = [];
        outputs[0].map((el: any) => {
          buf.push(Buffer.from(el));
        });
        resp = new Response(Readable.from(buf), rinit);
        break;
      case "off":
        return fetchFunc.apply(this, [url, options]);
      default:
        console.debug(
          "mode is not valid. Please set valid keploy mode using env variables"
        );
        return fetchFunc.apply(this, [url, options]);
    }
    return resp;
  }
  return mixin(wrappedFetch, fetchFunc, false);
}
