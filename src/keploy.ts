import HttpClient, { Request } from "./client";
import { transformToSnakeCase } from "./util";
import {OutgoingHttpHeaders} from "http"

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

export type HttpResponse = {
  statusCode: number,
  headers: OutgoingHttpHeaders,
  body: any[]
};

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
    const requestUrl = `regression/testcase/${id}`;
    const request = new Request();
    request.setHttpHeader("key", this.serverConfig.licenseKey);

    return this.client.makeHttpRequest(request.get(requestUrl));
  }

  private start(total: number) {
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

  private denoise(id: string, tcs: TestCaseRequest) {
    throw new Error("Not implemented");
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
      const response = await this.client.makeHttpRequest(
        request.get(requestUrl, { app, offset, limit })
      );

      testCases.push(response);

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
