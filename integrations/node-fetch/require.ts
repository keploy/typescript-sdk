/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
import Hook from "require-in-the-middle";
import { Headers, ResponseInit } from "node-fetch";
import mixin from "merge-descriptors";
import { getExecutionContext } from "../../src/context";
import { Readable } from "stream";
import { ProcessDep, stringToBinary } from "../../src/util";
import { putMocks } from "../../mock/utils";
import { HTTP, V1_BETA2 } from "../../src/keploy";
import { getRequestHeader, getResponseHeader } from "../express/middleware";
import { getReasonPhrase } from "http-status-codes";
import { DataBytes } from "../../proto/services/DataBytes";
import { MockIds } from "../../mock/mock";
import { MODE_OFF, MODE_RECORD, MODE_TEST } from "../../src/mode";

// @ts-ignore
Hook(["node-fetch"], function (exported) {
  const wrappedFetch = wrappedNodeFetch(exported);
  exported = wrappedFetch;
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

export function wrappedNodeFetch(fetch: any) {
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
    let resp = new fetch.Response();
    let rinit: ResponseInit = {};
    const meta = {
      name: "node-fetch",
      url: url,
      options: options,
      type: "HTTP_CLIENT",
    };
    switch (ctx.mode) {
      case MODE_RECORD:
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
            Version: V1_BETA2,
            Name: ctx.testId,
            Kind: HTTP,
            Spec: {
              Metadata: meta,
              Req: {
                URL: url,
                Body: JSON.stringify(options?.body),
                Header: getRequestHeader(options?.headers),
                Method: options?.method,
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
            MockIds[ctx.testId] !== true ? putMocks(httpMock) : "";
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
      case MODE_TEST:
        const outputs = new Array(2);
        if (
          ctx.mocks != undefined &&
          ctx.mocks.length > 0 &&
          ctx.mocks[0].Kind == HTTP
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
          if (ctx?.fileExport) {
            console.log(
              "🤡 Returned the mocked outputs for Http dependency call with meta: ",
              meta
            );
          }
          ctx.mocks.shift();
        } else {
          ProcessDep(ctx, {}, outputs);
        }
        rinit.headers = new Headers(outputs[1].headers);
        rinit.status = outputs[1].status;
        rinit.statusText = outputs[1].statusText;
        const buf: Buffer[] = [];
        outputs[0].map((el: any) => {
          buf.push(Buffer.from(el));
        });
        resp = new fetch.Response(Readable.from(buf), rinit);
        break;
      case MODE_OFF:
        return fetchFunc.apply(this, [url, options]);
      default:
        console.debug(
          `keploy mode '${ctx.mode}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
        );
        return fetchFunc.apply(this, [url, options]);
    }
    return resp;
  }
  return mixin(wrappedFetch, fetchFunc, false);
}
