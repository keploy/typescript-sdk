import HttpClient, { Request } from "./client";
import { transformToSnakeCase } from "./util";
import { OutgoingHttpHeaders } from "http";
import { request } from "express";

type AppConfigFilter = {
  urlRegex?: string;
};

type AppConfig = {
  name: string;
  host: string;
  port: number;
  delay: number;
  timeout: number;
  filter: AppConfigFilter;
};

type ServerConfig = {
  url: string;
  licenseKey: string;
};

type ID = string;

type HttpResponse = {
  statusCode: number;
  headers: OutgoingHttpHeaders;
  body: object[];
};

type TestCase = {
  id: ID;
  method: "get" | "post";
  url: string;
  body: string;
};

type TestCaseRequest = {
  captured: number;
  appId: string;
  uri: string;
  httpReq: object;
  httpResp: object;
};

export default class Keploy {
  appConfig: AppConfig;
  serverConfig: ServerConfig;
  responses: Record<ID, object>;
  dependencies: Record<ID, unknown>;
  client: HttpClient;

  constructor(app: AppConfig, server: ServerConfig) {
    this.appConfig = app;
    this.serverConfig = server;
    this.responses = {};
    this.dependencies = {};
    this.client = new HttpClient(this.serverConfig.url);
  }

  async create() {
    if (process.env.KEPLOY_MODE == "test") {
      await this.test();
    }
    return this;
  }

  getDependencies(id: ID) {
    this.dependencies[id];
  }

  getResp(id: ID) {
    this.responses[id];
  }

  putResp(id: ID, resp: HttpResponse) {
    this.responses[id] = resp;
  }

  capture(req: TestCaseRequest) {
    return this.put(req);
  }

  async test() {
    const testCases = await this.fetch();
    const totalTests = testCases.length;
    const testId = await this.start(totalTests);
    let passed = true;
    for (const testCase of testCases) {
      passed = await this.check(testId, testCase);
    }
    this.end(testId, passed);
    return passed;
  }

  async get(id: ID) {
    const requestUrl = `regression/testcase/${id}`;
    const request = new Request();
    request.setHttpHeader("key", this.serverConfig.licenseKey);

    return this.client.makeHttpRequest(request.get(requestUrl));
  }

  private start(total: number): Promise<ID> {
    const app = this.appConfig.name;
    const requestUrl = "regression/start";
    return this.client.makeHttpRequest(
      new Request().get(requestUrl, { app, total })
    );
  }

  private end(id: ID, status: boolean) {
    const requestUrl = "regression/end";
    return this.client.makeHttpRequest(
      new Request().get(requestUrl, { status, id })
    );
  }

  private simulate(tc: TestCase) {
    // @ts-ignore
    const requestUrl = `http://${this.appConfig.host}:${this.appConfig.port}${tc.http_req.url}`;
    return this.client.makeHttpRequestRaw<object>(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        // @ts-ignore
        .create(tc.http_req.method, requestUrl, tc.body)
    );
  }

  private async check(runId: ID, testcase: TestCase) {
    const resp = await this.simulate(testcase);
    console.log("after simulate: ", resp);
    const testreq = {
      id: testcase.id,
      AppID: this.appConfig.name,
      runId,
      httpRes: {
        status_code: resp.statusCode,
        headers: resp.headers,
        body: resp.rawBody.toString(),
      },
    };
    const requestUrl = "/regression/test";
    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");
    const resp2 = await this.client.makeHttpRequest<{ pass: boolean }>(
      request.post(requestUrl, JSON.stringify(testreq))
    );
    //const a = request.post(requestUrl,JSON.stringify(testreq));
    console.log("after post to keploy server: ", resp2);
    return resp2.pass;
  }

  private async put(tcs: TestCaseRequest) {
    if (
      this.appConfig.filter.urlRegex &&
      tcs.uri.match(this.appConfig.filter.urlRegex)
    ) {
      return;
    }

    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");

    return this.client.makeHttpRequest(
      request.post(
        "regression/testcase",
        JSON.stringify(transformToSnakeCase(tcs))
      )
    );
  }

  private async denoise(id: string, tcs: TestCaseRequest) {
    const test = await this.simulate({
      id: id,
      method: "get",
      url: tcs.uri,
      body: JSON.stringify(tcs.httpReq),
    });

    const testRequest = {
      id,
      appId: this.appConfig.name,
      httpRes: test,
    };

    const requestUrl = "regression/denoise";
    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");
    return this.client.makeHttpRequest(
      request.post(requestUrl, JSON.stringify(testRequest))
    );
  }

  async fetch(): Promise<TestCase[]> {
    let offset = 0;
    const limit = 25;
    const app = this.appConfig.name;
    const testCases = [];

    while (true) {
      const requestUrl = "regression/testcase";
      const request = new Request();
      this.setKey(request);
      const response = await this.client.makeHttpRequest<TestCase[]>(
        request.get(requestUrl, { app, offset, limit })
      );
      if (response === null) {
        break;
      }
      testCases.push(...response);

      if (response.length == 0) {
        break;
      }
      offset += 25;
    }

    return testCases;
  }

  private setKey(request: Request) {
    if (this.serverConfig.licenseKey) {
      request.setHttpHeader("key", this.serverConfig.licenseKey);
    }
  }
}
