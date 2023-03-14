/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
import { ResponseInit } from "node-fetch";
import { getExecutionContext } from "../../src/context";
import { Readable } from "stream";
import { ProcessDep, stringToBinary } from "../../src/util";
import { putMocks } from "../../mock/utils";
import { HTTP, V1_BETA2 } from "../../src/keploy";
import { getRequestHeader, getResponseHeader } from "../express/middleware";
import { getReasonPhrase } from "http-status-codes";
import { DataBytes } from "../../proto/services/DataBytes";
import { MockIds } from "../../mock/mock";

import { BatchInterceptor  } from '@mswjs/interceptors'
import { ClientRequestInterceptor  } from '@mswjs/interceptors/ClientRequest'
import { XMLHttpRequestInterceptor  } from '@mswjs/interceptors/XMLHttpRequest'

function getHeadersInit(headers: { [k: string]: string[] }): {
  [k: string]: string;
} {
  const result: { [key: string]: string } = {};
  for (const key in headers) {
    result[key] = headers[key].join(", ");
  }
  return result;
}

async function streamToString(stream: any) {
   const chunks: Buffer[] = [];
  
   for await (const chunk of stream) {
     chunks.push(Buffer.from(chunk));
   }

   return Buffer.concat(chunks).toString("utf-8");
}

async function streamToBuffer(stream: any) {
   const chunks: Buffer[] = [];
   for await (const chunk of stream) {
     chunks.push(Buffer.from(chunk));
   }
   return chunks
}

const interceptor = new BatchInterceptor({
  name: 'my-interceptor',
  interceptors: [
    new ClientRequestInterceptor(),
    new XMLHttpRequestInterceptor(),
  ],
})

interceptor.apply()

interceptor.on('request', async (request, requestId) => {
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error("keploy context is not present to mock dependencies");
    return;
  }
  const ctx = getExecutionContext().context;
  const meta = {
    name: "khttp",
    url: request.url,
    type: "HTTP_CLIENT",
  };
  if (ctx.mode === 'test') {
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
      ProcessDep({}, outputs);
    }
    //rinit.headers = new Headers(outputs[1].headers);
    const buf: Buffer[] = [];
    outputs[0].map((el: any) => {
      buf.push(Buffer.from(el));
    });
    const bodyText = await streamToString(Readable.from(buf))
    request.respondWith(
      new Response(
        bodyText,
        {
          status: outputs[1].status,
          statusText: outputs[1].statusText,
          headers: outputs[1].headers
        }
      )
    )
  }
})

interceptor.on('response', async (response, request) => {
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error("keploy context is not present to mock dependencies");
    return;
  }
  const ctx = getExecutionContext().context;
  let rinit: ResponseInit = {};
  const meta = {
    name: "khttp",
    url: request.url,
    type: "HTTP_CLIENT",
  };
  if (ctx.mode === 'record') {
    rinit = {
      headers: Object.fromEntries(response.headers),
      status: response.status,
      statusText: response.statusText,
    };
    let respData: Buffer[] = [];
    respData = await streamToBuffer(response.body)
    let body = await streamToString(response.body)
    const httpMock = {
      Version: V1_BETA2,
      Name: ctx.testId,
      Kind: HTTP,
      Spec: {
        Metadata: meta,
        Req: {
          URL: request.url,
          Body: JSON.stringify(request.body),
          Header: getRequestHeader(Object.fromEntries(request.headers)),
          Method: request.method,
        },
        Res: {
          StatusCode: response.status,
          Header: getResponseHeader(rinit.headers),
          Body: body
        },
      },
    };
    // record mocks for unit-test-mock-library
    if (ctx.fileExport === true) {
      MockIds[ctx.testId] !== true ? putMocks(httpMock) : "";
    } else {
      ctx.mocks.push(httpMock);
      const res: DataBytes[] = [];
      res.push({ Bin: stringToBinary(JSON.stringify(respData)) });
      res.push({ Bin: stringToBinary(JSON.stringify(rinit)) });
      ctx.deps.push({
        Name: meta.name,
        Type: meta.type,
        Meta: meta,
        Data: res,
      });
    }
  }
})
