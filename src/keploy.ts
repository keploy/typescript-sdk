import HttpClient, { Request } from "./client";

type AppConfigFilter = {
  urlRegex: string;
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

type HttpResponse = unknown;

type TestCase = unknown;

type TestCaseRequest = {
  captured: number;
  appId: string;
  uri: string;
  httpReq: object;
  httpRes: object;
};

export default class Keploy {
  appConfig: AppConfig;
  serverConfig: ServerConfig;
  responses: Record<ID, unknown>;
  dependencies: Record<ID, unknown>;
  client: HttpClient;

  constructor(app: AppConfig, server: ServerConfig) {
    this.appConfig = app;
    this.serverConfig = server;
    this.responses = {};
    this.dependencies = {};
    this.client = new HttpClient(this.serverConfig.url);
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

  test() {
    throw new Error("Not implemented");
  }

  async get(id: ID) {
    const requestUrl = `/regression/testcase/${id}`;
    const request = new Request();
    request.setHttpHeader("key", this.serverConfig.licenseKey);

    return this.client.makeHttpRequest(request.get(requestUrl));
  }

  private start(total: number) {
    const app = this.appConfig.name;
    const requestUrl = `/regression/start?app=${app}&total=${total}`;
    return this.client.makeHttpRequest(new Request().get(requestUrl));
  }

  private end(id: ID, status: boolean) {
    const requestUrl = `/regression/start?status=${status}&id=${id}`;
    return this.client.makeHttpRequest(new Request().get(requestUrl));
  }

  private simulate(tc: TestCase) {
    throw new Error("Not implemented");
  }

  private async put(tcs: TestCaseRequest) {
    if (tcs.uri.match(this.appConfig.filter.urlRegex)) {
      return;
    }

    const request = new Request();
    this.setKey(request);
    request.setHttpHeader("Content-Type", "application/json");

    return this.client.makeHttpRequest(
      request.post("/regression/testcase", Buffer.from(JSON.stringify(tcs)))
    );
  }

  private denoise(id: string, tcs: TestCaseRequest) {
    throw new Error("Not implemented");
  }

  private fetch() {
    const offset = 0;
    const limit = 25;
    const app = this.appConfig.name;
    const requestUrl = `/regression/testcase?app=${app}&offset=${offset}&limit=${limit}`;
    const request = new Request();
    this.setKey(request);

    return this.client.makeHttpRequest(request.get(requestUrl));
  }

  private setKey(request: Request) {
    request.setHttpHeader("key", this.serverConfig.licenseKey);
  }
}
