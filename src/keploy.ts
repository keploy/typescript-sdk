import HttpClient, { Request } from "./client";
import { transformToSnakeCase } from "./util";
import { OutgoingHttpHeaders } from "http";
import { getRequestHeader } from "../integrations/express/middleware";

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
  uri: string;
  http_req: object;
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
    // const keploy = new Keploy(app, server);
    if (process.env.KEPLOY_MODE == "test") {
      // setTimeout(keploy.test, 5000);
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

  private async start(total: number) {
    const app = this.appConfig.name;
    const requestUrl = "regression/start";
    const resp: { [key: string]: string } = await this.client.makeHttpRequest(
      new Request().get(requestUrl, { app, total })
    );
    return resp.id;
  }

  private end(id: string, status: boolean) {
    const requestUrl = "regression/end";
    return this.client.makeHttpRequest(
      new Request().get(requestUrl, { status, id })
    );
  }

  private simulate(tc: TestCase) {
    const client = new HttpClient(
      `http://${this.appConfig.host}:${this.appConfig.port}`
    );
    //@ts-ignore
    const requestUrl = `${tc.http_req.url.substr(1)}`;
    return client.makeHttpRequestRaw<object>(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        //@ts-ignore
        .create(tc.http_req.method, requestUrl, tc.http_req.body)
    );
  }

  private async check(runId: string, testcase: TestCase) {
    const resp = await this.simulate(testcase);
    const header = getRequestHeader(resp.headers);
    const testreq = {
      id: testcase.id,
      appId: this.appConfig.name,
      runId: runId,
      resp: {
        status_code: resp.statusCode,
        header: header,
        body: resp.rawBody.toString(),
      },
    };
    const requestUrl = "regression/test";
    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");
    const resp2 = await this.client.makeHttpRequest<{ pass: boolean }>(
      request.post(requestUrl, JSON.stringify(transformToSnakeCase(testreq)))
    );
    //const a = request.post(requestUrl,JSON.stringify(testreq));
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

    const resp = await this.client.makeHttpRequest<{ id: string }>(
      request.post(
        "regression/testcase",
        JSON.stringify(transformToSnakeCase(tcs))
      )
    );
    if (resp.id === "") {
      return;
    }
    this.denoise(resp.id, tcs);
  }

  private async denoise(id: string, tcs: TestCaseRequest) {
    const resp = await this.simulate({
      id: id,
      uri: tcs.uri,
      http_req: tcs.httpReq,
    });
    const header = getRequestHeader(resp.headers);
    const testRequest = {
      id,
      appId: this.appConfig.name,
      resp: {
        status_code: resp.statusCode,
        header: header,
        body: resp.rawBody.toString(),
      },
    };

    const requestUrl = "regression/denoise";
    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");
    return this.client.makeHttpRequest(
      request.post(
        requestUrl,
        JSON.stringify(transformToSnakeCase(testRequest))
      )
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
