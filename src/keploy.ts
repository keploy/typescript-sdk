/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */
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
import assert = require("assert");
import { createExecutionContext, getExecutionContext } from "./context";

const PROTO_PATH = "../../grpc.proto";
const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_PATH));
const grpcObj = grpc.loadPackageDefinition(
  packageDef
) as unknown as ProtoGrpcType;

// export const Http = "Http";
export const V1_BETA2 = "api.keploy.io/v1beta2",
  V1_BETA1 = "api.keploy.io/v1beta1",
  HTTP = "Http",
  GENERIC = "Generic";

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
  mocks: Record<ID, unknown>;
  grpcClient: RegressionServiceClient;

  constructor(
    app: Partial<AppConfig> = {},
    server: Partial<ServerConfig> = {}
  ) {
    this.appConfig = this.validateAppConfig(app);
    this.serverConfig = this.validateServerConfig(server);
    this.grpcClient = new grpcObj.services.RegressionService(
      this.serverConfig.url,
      grpc.credentials.createInsecure()
    );
    this.responses = {};
    this.dependencies = {};
    this.mocks = {};
  }

  validateServerConfig({
    url = process.env.KEPLOY_SERVER_URL || "localhost:6789",
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
    // testCasePath and mockPath can be defined in the .env file. If not defined then a folder named
    // keploy-tests will be created which will contain mock folder.
    testCasePath = path.resolve(
      process.env.KEPLOY_TEST_CASE_PATH || "./keploy-tests"
    ),
    mockPath = path.resolve(
      process.env.KEPLOY_MOCK_PATH || "./keploy-tests/mock"
    ),
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

  async runTests() {
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

  getMocks(id: ID) {
    return this.mocks[id] as object[] | undefined;
  }

  getResp(id: ID) {
    return this.responses[id];
  }

  // stores http response for unique test-ids to capture them at middleware layer
  putResp(id: ID, resp: HttpResponse) {
    // put http response in map only once for unique test-ids. Since, finish event
    // can trigger multiple time for redirect.
    if (this.responses[id] === null || this.responses[id] === undefined) {
      this.responses[id] = resp;
    }
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
        if (err !== null) {
          console.error("failed to fetch test cases from keploy. error: ", err);
        }
        if (
          response == null ||
          response.tcs == undefined ||
          response.tcs.length == 0
        ) {
          // Base case of the recursive function.
          // If the response is null then all the testcases cases will go to the afterfetch function.
          end = true;
          this.afterFetch(testcases);
          return;
        }
        testcases.push(...response.tcs);
        if (response.eof == true) {
          // Base case of the recursive function.
          // If the eof is true then all the testcases cases will go to the afterfetch function.
          end = true;
          this.afterFetch(testcases);
          return testcases;
        }
        // Recursive call to the function fetch.
        this.fetch(testcases, offset + 25);
      }
    );
    return testcases;
  }

  async test() {
    await this.fetch([], 0);
  }

  // returns promise to capture the code coverage of recorded testc cases
  async assertTests() {
    return new Promise(async (resolve) => {
      createExecutionContext({ resolve: resolve });
      await this.test();
    });
  }
  // afterFetch fuction contains Start, Test and End grpc calls to the function.
  // The nesting is done in the grpc calls because they return their responses in the callback function.
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
          console.error("failed to call start method of keploy. error: ", err);
        }
        const testId = resp?.id;

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
              TestCasePath: this.appConfig.testCasePath,
              MockPath: this.appConfig.mockPath,
              Type: HTTP,
            },
            (err, response) => {
              if (err !== null) {
                console.error(
                  "failed to call test method of keploy. error: ",
                  err
                );
              }

              if (response?.pass?.pass === false) {
                pass = false;
              }
              console.log(
                "result { testcase id: ",
                testCase.id,
                " }, { passed: ",
                response?.pass?.pass,
                " }"
              );

              if (i === testCases.length - 1) {
                this.end(testId, pass);
                console.log(
                  "test run completed { run id: ",
                  testId,
                  " }, passed overall: ",
                  pass
                );
                // fetches resolve function of the Promise which was returned to unit test for code-coverage
                const resolve = getExecutionContext()?.context?.resolve;
                if (resolve !== undefined) {
                  // asserts for testrun result
                  assert.equal(pass, true);
                  resolve(1);
                }
              }
            }
          );
        }
      }
    );
  }

  async get(id: ID) {
    this.grpcClient.GetTC({ id: id }, (err, resp) => {
      if (err !== null) {
        console.error("failed to get testcase with id: ", id, ", error: ", err);
      }
    });
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
    // return resp.id;
  }

  private async simulate(tc: TestCase) {
    if (tc.id == undefined) {
      return;
    }
    this.dependencies[tc.id] = tc.Deps;
    this.mocks[tc.id] = tc.Mocks;

    const headers: { [key: string]: string | string[] } = {
      KEPLOY_TEST_ID: tc.id,
    };
    if (tc.HttpReq?.Header !== undefined) {
      Object.assign(headers, toHttpHeaders(tc.HttpReq?.Header));
    }
    const client = new HttpClient(
      `http://${this.appConfig.host}:${this.appConfig.port}`
    );
    //@ts-ignore
    const requestUrl = `${tc.HttpReq?.URL.substr(1)}`;

    await client.makeHttpRequestRaw(
      new Request()
        .setHttpHeader("KEPLOY_TEST_ID", tc.id)
        //@ts-ignore
        .setHttpHeaders(headers)
        //@ts-ignore
        .create(tc.HttpReq?.Method, requestUrl, tc.HttpReq?.Body)
    );
    const resp = this.getResp(tc.id);
    delete this.dependencies[tc.id];
    delete this.mocks[tc.id];
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
      Mocks: tcs.Mocks,
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
        Type: HTTP,
      },
      (err, response) => {
        if (err != undefined) {
          console.error(
            "failed to call denoise method of keploy. error: ",
            err
          );
        }
        return response;
      }
    );
  }
}
