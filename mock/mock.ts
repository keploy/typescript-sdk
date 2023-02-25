/* eslint-disable @typescript-eslint/no-explicit-any */
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path, { resolve } from "path";
import { ProtoGrpcType } from "../proto/services";
import Mode, { MODE_TEST } from "../src/mode";
import { createExecutionContext, getExecutionContext } from "../src/context";
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
export function NewContext(conf: Config) {
  let mode = MODE_TEST,
    path = conf !== undefined && conf.Path !== undefined ? conf.Path : "";

  if (path === "") {
    try {
      path = process.cwd();
    } catch (err) {
      console.log("Failed to get the path of current directory");
      console.log(err);
      console.log("Keploy mode:",process.env.KEPLOY_MODE)
    }
  } else if (path[0] !== "/") {
    try {
      path = resolve(conf.Path);
    } catch (err) {
      console.log("Failed to get the absolute path from relative conf.path");
      console.log(err);
      console.log("Keploy mode:",process.env.KEPLOY_MODE)
    }
  }
  path += "/mocks";
  mockPath = path;

  if (
    process.env.KEPLOY_MODE !== undefined &&
    Mode.Valid(process.env.KEPLOY_MODE)
  ) {
    //   if (process.)
    mode = process.env.KEPLOY_MODE;
  }
  // mode mostly dependent on conf.Mode
  if (Mode.Valid(conf.Mode)) {
    mode = conf.Mode;
  }
  switch (mode) {
    case "test":
      if (conf.Name === "") {
        console.log(
          "🚨 Please enter the auto generated name to mock the dependencies using Keploy."
        );
      }
      createExecutionContext({
        mode: mode,
        testId: conf.Name,
        mocks: [],
        fileExport: true,
      });
      const ctx = getExecutionContext().context;
      grpcClient.GetMocks({ Path: path, Name: conf.Name }, (err, response) => {
        if (err) {
          console.error(err);
          return;
        }
        ctx.mocks = response?.Mocks;
        return response;
      });
      break;
    case "record":
      createExecutionContext({
        mode: mode,
        testId: conf.Name,
        mocks: [],
        fileExport: true,
      });
      break;
    default:
      console.log("Keploy mode: (", mode, ") is not a valid mode");
      break;
  }

  let name = "";
  if (conf.Name !== "") {
    name = "for " + conf.Name;
  }
  console.log(
    "\n💡⚡️ Keploy created new mocking context in",
    mode,
    "mode",
    name,
    ".\n If you dont see any logs about your dependencies below, your dependency/s are NOT wrapped.\n"
  );
  startRecordingMocks(path + "/" + conf.Name + ".yaml", mode, name, conf.Name);
}
