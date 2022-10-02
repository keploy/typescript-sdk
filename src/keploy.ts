import HttpClient, { Request } from "./client";
import { toHttpHeaders, transformToSnakeCase } from "./util";
import { getRequestHeader } from "../integrations/express/middleware";
import { name as packageName } from "../package.json";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { ProtoGrpcType } from "../proto/services";
import path from "path";
import { RegressionServiceClient } from "../proto/services/RegressionService";
import { TestCaseReq } from "../proto/services/TestCaseReq";
import { TestCase } from "../proto/services/TestCase";
import { StrArr } from "../proto/services/StrArr";

const PORT = 8081;
const PROTO_PATH = "../proto/services.proto";
const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_PATH));
const grpcObj = grpc.loadPackageDefinition(
  packageDef
) as unknown as ProtoGrpcType;

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
  testCasePath: string;
  mockPath: string;
};

type ServerConfig = {
  url: string;
  licenseKey: string;
};

type ID = string;

type HttpResponse = {
  status_code: number;
  header: { [key: string]: StrArr };
  body: string;
};

export default class Keploy {
  appConfig: AppConfig;
  serverConfig: ServerConfig;
  responses: Record<ID, HttpResponse>;
  dependencies: Record<ID, unknown>;
  client: HttpClient;
  grpcClient: RegressionServiceClient;

  constructor(
    app: Partial<AppConfig> = {},
    server: Partial<ServerConfig> = {}
  ) {
    this.grpcClient = new grpcObj.services.RegressionService(
      `0.0.0.0:${PORT}`,
      grpc.credentials.createInsecure()
    );
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
    testCasePath = path.resolve(process.env.KEPLOY_TEST_CASE_PATH || "./" + "keploy-tests"),
    mockPath = path.resolve(process.env.KEPLOY_MOCK_PATH || "./" + "keploy-tests/mock"),
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

    return { name, host, port, delay, timeout, filter, testCasePath, mockPath };
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
    return this.dependencies[id] as object[] | undefined;
  }

  getResp(id: ID) {
    return this.responses[id];
  }

  putResp(id: ID, resp: HttpResponse) {
    this.responses[id] = resp;
  }

  capture(req: TestCaseReq) {
    return this.put(req);
  }

  async fetch(testcases: TestCase[], offset: number) {
    const limit = 25;
    const app = this.appConfig.name;
    let end = false;
    await this.grpcClient.getTcs(
      {
        app: app,
        offset: offset.toString(),
        limit: limit.toString(),
        TestCasePath: this.appConfig.testCasePath,
        MockPath: this.appConfig.mockPath,
      },
      (err, response) => {
        if (err !== undefined) {
          console.error("failed to call getTcs method of keploy. error: ", err);
        }
        console.log(response);
        if (
          response == null ||
          response.tcs == undefined ||
          response.tcs.length == 0
        ) {
          end = true;
          this.afterFetch(testcases);
          return;
        }
        testcases.push(...response.tcs);
        if (response.eof == true) {
          end = true;
          this.afterFetch(testcases);
          return testcases;
        }
        this.fetch(testcases, offset + 25);
      }
    );
    return testcases;
  }

  async test() {
    const testCases = await this.fetch([], 0);
    if (testCases == undefined) {
      console.log("testcases is undefinded");
      return;
    }
  }

  async afterFetch(testCases: TestCase[]) {
    const totalTests = testCases.length;
    this.grpcClient.Start(
      {
        app: this.appConfig.name,
        total: totalTests.toString(),
        MockPath: this.appConfig.mockPath,
        TestCasePath: this.appConfig.testCasePath,
      },
      async (err, resp) => {
        if (err !== null) {
          console.error("failed to call test method of keploy. error: ", err);
        }
        const testId = resp?.id;

        console.log("starting test execution. { id: ",testId," }, { total tests: ",totalTests," }");
        let pass = true;
        for (const [i, testCase] of testCases.entries()) {
          console.log("testing ",i + 1," of ",totalTests," { testcase id: ",testCase.id," }");
          const resp = await this.simulate(testCase).catch((err) =>
            console.log(err)
          );
          this.grpcClient.Test(
            {
              AppID: this.appConfig.name,
              ID: testCase.id,
              RunID: testId,
              Resp: {
                Body: resp?.body,
                StatusCode: resp?.status_code,
                Header: resp?.header,
              },
            },
            (err, response) => {
              if (err !== null) {
                console.error("failed to call test method of keploy. error: ",err);
              }
              if (response?.pass?.pass === false) {
                pass = false;
              }
              console.log("result { testcase id: ",testCase.id," }, { passed: ",response?.pass?.pass," }");
              console.log("\n tcs index:", i, "\n");
              if (i === testCases.length - 1) {
                this.end(testId, pass);
                console.log("test run completed { run id: ",testId," }, passed overall: ",pass);
              }
            }
          );
        }
      }
    );
  }

  async get(id: ID) {
    const requestUrl = `regression/testcase/${id}`;
    const request = new Request();
    request.setHttpHeader("key", this.serverConfig.licenseKey);

    return this.client.makeHttpRequest(request.get(requestUrl));
  }

  private end(id: string | undefined, status: boolean) {
    this.grpcClient.End(
      { id: id, status: status.toString() },
      (err, response) => {
        if (err !== null) {
          console.error("failed to call end method of keploy. error: ", err);
        }
      }
    );
  }

  private async simulate(tc: TestCase) {
    if (tc.id == undefined) {
      return;
    }
    this.dependencies[tc.id] = tc.Deps;

    const client = new HttpClient(
      `http://${this.appConfig.host}:${this.appConfig.port}`
    );
    //@ts-ignore
    const requestUrl = `${tc.HttpReq?.URL.substr(1)}`;

    const http_resp = await client.makeHttpRequestRaw<object>(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        //@ts-ignore
        .setHttpHeaders(toHttpHeaders(tc.HttpReq?.Header))
        //@ts-ignore
        .create(tc.HttpReq?.Method, requestUrl, tc.HttpReq?.Body)
    );
    const resp = this.getResp(tc.id);
    delete this.responses[tc.id];
    return resp;
  }

  private async put(tcs: TestCaseReq) {
    if (
      this.appConfig.filter.urlRegex &&
      tcs?.URI?.match(this.appConfig.filter.urlRegex)
    ) {
      return;
    }

    this.grpcClient.PostTC(tcs, (err, response) => {
      if (err != null) {
        console.error("failed to post testcase to keploy server. error: ", err);
      }
      if (
        response === undefined ||
        response.tcsId === undefined ||
        response.tcsId.id === ""
      ) {
        return;
      }
      this.denoise(response.tcsId.id, tcs);
    });
  }

  private async denoise(id: string, tcs: TestCaseReq) {
    if (tcs.URI === undefined) {
      return;
    }
    const resp = await this.simulate({
      id: id,
      URI: tcs.URI,
      HttpReq: tcs.HttpReq,
      Deps: tcs.Dependency,
    }).catch((err) => console.log(err));
    this.grpcClient.DeNoise(
      {
        AppID: this.appConfig.name,
        ID: id,
        Resp: {
          Body: resp?.body,
          Header: resp?.header,
          StatusCode: resp?.status_code,
        },
        TestCasePath: this.appConfig.testCasePath,
        MockPath: this.appConfig.mockPath,
      },
      (err, response) => {
        if (err != undefined) {
          console.error("failed to call denoise method of keploy. error: ",err);
        }
        return response;
      }
    );
  }
}
