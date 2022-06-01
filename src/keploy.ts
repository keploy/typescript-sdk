import HttpClient, { Request } from "./client";
import { transformToSnakeCase } from "./util";
import { OutgoingHttpHeaders } from "http";

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
    name = process.env.KEPLOY_APP_NAME || "keploy-app",
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
    testCases.forEach((testCase) => {
      passed = this.check(testId, testCase);
    });
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
    const requestUrl = `http://${this.appConfig.host}:${this.appConfig.port}${tc.url}`;
    return this.client.makeHttpRequest<object>(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        .create(tc.method, requestUrl, tc.body)
    );
  }

  private check(runId: ID, testcase: TestCase): boolean {
    throw new Error("Not implemented");
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
    const offset = 0;
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

      testCases.push(...response);

      if (response.length == 0) {
        break;
      }
    }

    return testCases;
  }

  private setKey(request: Request) {
    if (this.serverConfig.licenseKey) {
      request.setHttpHeader("key", this.serverConfig.licenseKey);
    }
  }
}
