import HttpClient, { Request } from "./client";
import { transformToSnakeCase } from "./util";
import { OutgoingHttpHeaders } from "http";
import { getRequestHeader } from "../integrations/express/middleware";
import { name as packageName } from "../package.json";
import assert = require("assert");

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
  status_code: number;
  header: { [key: string]: string[] };
  body: string;
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
  responses: Record<ID, HttpResponse>;
  dependencies: Record<ID, unknown>;
  client: HttpClient;

  constructor(
    app: Partial<AppConfig> = {},
    server: Partial<ServerConfig> = {}
  ) {
    this.appConfig = this.validateAppConfig(app);
    this.serverConfig = this.validateServerConfig(server);
    this.responses = {};
    this.dependencies = {};
    this.client = new HttpClient(this.serverConfig.url);
  }

  validateServerConfig({
    url = process.env.KEPLOY_SERVER_URL || "http://localhost:8081/api",
    licenseKey = process.env.KEPLOY_LICENSE_KEY || "",
  }) {
    return { url, licenseKey };
  }

  validateAppConfig({
    name = process.env.KEPLOY_APP_NAME || packageName,
    host = process.env.KEPLOY_APP_HOST || "localhost",
    port = process.env.KEPLOY_APP_PORT || 8080,
    delay = process.env.KEPLOY_APP_DELAY || 5,
    timeout = process.env.KEPLOY_APP_TIMEOUT || 60,
    filter = process.env.KEPLOY_APP_FILTER || {},
  }) {
    const errorFactory = (key: string) =>
      new Error(`Invalid App config key: ${key}`);

    port = Number(port);
    if (Number.isNaN(port)) {
      throw errorFactory("port");
    }

    delay = Number(delay);
    if (Number.isNaN(delay)) {
      throw errorFactory("delay");
    }

    timeout = Number(timeout);
    if (Number.isNaN(timeout)) {
      throw errorFactory("timeout");
    }

    if (typeof filter === "string") {
      try {
        filter = JSON.parse(filter);
      } catch {
        throw errorFactory("filter");
      }
    }

    return { name, host, port, delay, timeout, filter };
  }

  async create() {
    if (process.env.KEPLOY_MODE == "test") {
      console.log("test starting in " + this.appConfig.delay + "s");
      setTimeout(async () => {
        await this.test();
      }, this.appConfig.delay * 1000);
      // await this.test();
    }
    return this;
  }

  getDependencies(id: ID) {
    this.dependencies[id];
  }

  getResp(id: ID) {
    return this.responses[id];
  }

  putResp(id: ID, resp: HttpResponse) {
    this.responses[id] = resp;
  }

  capture(req: TestCaseRequest) {
    return this.put(req);
  }

  setTestMode() {
    process.env.KEPLOY_MODE = "test";
  }

  async test() {
    const testCases = await this.fetch();
    const totalTests = testCases.length;
    const testId = await this.start(totalTests);
    console.log(
      "starting test execution. { id: ",
      testId,
      " }, { total tests: ",
      totalTests,
      " }"
    );
    let pass = true;
    for (const [i, testCase] of testCases.entries()) {
      console.log(
        "testing ",
        i + 1,
        " of ",
        totalTests,
        " { testcase id: ",
        testCase.id,
        " }"
      );
      const passed = await this.check(testId, testCase);
      if (!passed) {
        pass = false;
      }
      console.log(
        "result { testcase id: ",
        testCase.id,
        " }, { passed: ",
        passed,
        " }"
      );
    }
    this.end(testId, pass);
    console.log(
      "test run completed { run id: ",
      testId,
      " }, passed overall: ",
      pass
    );
    return pass;
  }

  async assertTests() {
    const res = await this.test();
    assert.equal(res, true);
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

  private async simulate(tc: TestCase) {
    const client = new HttpClient(
      `http://${this.appConfig.host}:${this.appConfig.port}`
    );
    //@ts-ignore
    const requestUrl = `${tc.http_req.url.substr(1)}`;

    const http_resp = await client.makeHttpRequestRaw<object>(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        //@ts-ignore
        .setHttpHeaders(tc.http_req.header)
        //@ts-ignore
        .create(tc.http_req.method, requestUrl, tc.http_req.body)
    );
    const resp = this.getResp(tc.id);
    delete this.responses[tc.id];
    if (
      (resp.status_code < 300 || resp.status_code >= 400) &&
      resp.body != http_resp.rawBody.toString()
    ) {
      const header = getRequestHeader(http_resp.headers);
      // eslint-disable-next-line prettier/prettier
      resp.body = http_resp.rawBody.toString();
      resp.header = header;
      resp.status_code = http_resp.statusCode;
    }
    return resp;
  }

  private async check(runId: string, testcase: TestCase) {
    const resp = await this.simulate(testcase).catch((err) => console.log(err));
    const testreq = {
      id: testcase.id,
      appId: this.appConfig.name,
      runId: runId,
      resp,
    };
    const requestUrl = "regression/test";
    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");
    const resp2 = await this.client.makeHttpRequest<{ pass: boolean }>(
      request.post(requestUrl, JSON.stringify(transformToSnakeCase(testreq)))
    );
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
    }).catch((err) => console.log(err));
    const testRequest = {
      id,
      appId: this.appConfig.name,
      resp,
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
