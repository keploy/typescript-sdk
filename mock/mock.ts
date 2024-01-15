/* eslint-disable @typescript-eslint/no-explicit-any */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path, { resolve } from "path";
import { ProtoGrpcType } from "../proto/services";
import Mode, { MODE_TEST } from "../src/mode";
import { createExecutionContext } from "../src/context";
import { startRecordingMocks } from "./utils";

const PORT = 6789;
const PROTO_FILE = "../proto/services.proto";
const packageDef = protoLoader.loadSync(path.resolve(__dirname, PROTO_FILE));
const grpcObj = grpc.loadPackageDefinition(
  packageDef
) as unknown as ProtoGrpcType;
export const grpcClient = new grpcObj.services.RegressionService(
  `0.0.0.0:${PORT}`,
  grpc.credentials.createInsecure()
);

export let mockPath = "";
export const MockIds: Record<string, unknown> = {};

export interface Config {
  Name: string;
  Path: string;
  Mode: string;
}

// NewContext is used to populate the context to mock/capture the dependency calls.
// Since, grpc unary calls are made, Promise is returned to sync the outputs
// before the external dependency calls from unit tests.
export function NewContext(conf: Config): Promise<string> {
  const mode = new Mode();
  // default mode should be TEST
  mode.SetMode(MODE_TEST);
  if (
    process.env.KEPLOY_MODE !== undefined &&
    Mode.Valid(process.env.KEPLOY_MODE)
  ) {
    mode.SetMode(process.env.KEPLOY_MODE);
  }
  // mode mostly dependent on conf.Mode
  if (Mode.Valid(conf.Mode)) {
    mode.SetMode(conf.Mode);
  }

  let path = conf !== undefined && conf.Path !== undefined ? conf.Path : "";
  if (path === "") {
    try {
      path = process.cwd();
    } catch (err) {
      console.log("Failed to get the path of current directory");
      console.log(err);
    }
  } else if (path[0] !== "/") {
    try {
      path = resolve(conf.Path);
    } catch (err) {
      console.log("Failed to get the absolute path from relative conf.path");
      console.log(err);
    }
  }
  path += "/mocks";
  mockPath = path;

  let name = "";
  if (conf.Name !== "") {
    name = "for " + conf.Name;
  }
  console.log(
    "\n💡⚡️ Keploy created new mocking context in",
    mode.GetMode(),
    "mode",
    name,
    ".\n If you dont see any logs about your dependencies below, your dependency/s are NOT wrapped.\n"
  );
  const ctx: { mode: string; testId: string; fileExport: boolean; mocks: any } =
    {
      mode: mode.GetMode(),
      testId: conf.Name,
      fileExport: true,
      mocks: [],
    };
  switch (mode.GetMode()) {
    case "test":
      if (conf.Name === "") {
        console.log(
          "🚨 Please enter the auto generated name to mock the dependencies using Keploy."
        );
      }
      createExecutionContext(ctx);
    case "record":
      createExecutionContext(ctx);
  }

  // returns Promise to sync the outputs from the grpc unary calls
  return new Promise((rsolve, reject) => {
    switch (mode.GetMode()) {
      case "test":
        grpcClient.GetMocks(
          { Path: path, Name: conf.Name },
          (err, response) => {
            if (err) {
              console.error(err);
              reject(err);
              return;
            }
            ctx.mocks = response?.Mocks;
            rsolve("passed");
            return response;
          }
        );
        break;
      case "record":
        startRecordingMocks(
          path + "/" + conf.Name + ".yaml",
          mode.GetMode(),
          name,
          conf.Name,
          rsolve,
          reject
        );
        break;
      default:
        console.log("Keploy mode: (", mode.GetMode(), ") is not a valid mode");
        reject(`Keploy mode: (${mode.GetMode()}) is not a valid mode`);
        break;
    }
  });
}
