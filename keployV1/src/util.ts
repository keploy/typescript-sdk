/* eslint-disable @typescript-eslint/no-explicit-any */

import { DataBytes } from "../proto/services/DataBytes";
import { StrArr } from "../proto/services/StrArr";
import { getExecutionContext } from "./context";
import { GENERIC, V1_BETA2 } from "./keploy";

/**
 * Converts all of the keys of an existing object from camelCase to snake_case.
 * @param obj Any object, ideally with camelCase keys.
 * @returns A new object, with camelCase keys replaced with snake_case keys.
 */
const transformToSnakeCase = (obj: any): object => {
  const snakeCaseObj: any = {};

  for (const key of Object.keys(obj)) {
    const snakeCaseKey = key.replace(
      /[A-Z]/g,
      (char) => `_${char.toLowerCase()}`
    );
    snakeCaseObj[snakeCaseKey] = obj[key];
  }
  return snakeCaseObj;
};

export { transformToSnakeCase };

export function ProcessDep(
  kctx: any,
  meta: { [key: string]: string },
  ...outputs: any[]
) {
  // if (
  //   getExecutionContext() == undefined ||
  //   getExecutionContext().context == undefined
  // ) {
  //   console.error("keploy context is not present to mock dependencies");
  //   return;
  // }
  // const kctx = getExecutionContext().context;
  switch (kctx.mode) {
    case "record":
      const res: DataBytes[] = [];
      for (let i = 0; i < outputs.length; i++) {
        // since, JSON.stringify removes all values with undefined. We updated undefined values to "undefined" string
        if (outputs[i] === undefined) {
          outputs[i] = "undefined";
        }
        res.push({ Bin: stringToBinary(JSON.stringify(outputs[i])) });
      }
      kctx.deps.push({
        Name: meta.name,
        Type: meta.type,
        Meta: meta,
        Data: res,
      });
      // @ts-ignore
      const protoObjs = [];
      for (let i = 0; i < res.length; i++) {
        protoObjs.push({
          Type: typeof outputs[i],
          Data: res[i].Bin,
        });
      }
      kctx.mocks.push({
        Version: V1_BETA2,
        Kind: GENERIC,
        Name: kctx.testId,
        Spec: {
          Metadata: meta,
          Objects: protoObjs,
        },
      });
      break;
    case "test":
      if (kctx.mocks.length === 0) {
        if (kctx.deps == undefined || kctx.deps.length == 0) {
          console.error(
            "dependency failed: New unrecorded dependency call for tcs with test id: %s",
            kctx.testId
          );
          return undefined;
        }
        if (outputs.length !== kctx.deps[0].Data.length) {
          console.error(
            "dependency failed: Non-Sequential dependency call for tcs with test id: %s",
            kctx.testId
          );
          return undefined;
        }

        for (let i = 0; i < outputs.length; i++) {
          outputs[i] = JSON.parse(binaryToString(kctx.deps[0].Data[i].Bin));
          // since, JSON.stringify removes all values with undefined. We updated undefined values to "undefined" string
          if (outputs[i] === "undefined") {
            outputs[i] = undefined;
          }
        }
        kctx.deps = kctx.deps.slice(1);
        return outputs;
      }
      if (kctx.mocks === undefined || kctx.mocks.length == 0) {
        console.error(
          "mocking failed: New unrecorded dependency call for tcs with test id: %s",
          kctx.testId
        );
        return undefined;
      }
      if (outputs.length !== kctx.mocks[0].Spec.Objects.length) {
        console.error(
          "dependency failed: Non-Sequential dependency call for tcs with test id: %s",
          kctx.testId
        );
        return undefined;
      }

      for (let i = 0; i < outputs.length; i++) {
        const bin = kctx.mocks[0].Spec.Objects[i].Data;
        outputs[i] = JSON.parse(binaryToString(bin));
        // since, JSON.stringify removes all values with undefined. We updated undefined values to "undefined" string
        if (outputs[i] === "undefined") {
          outputs[i] = undefined;
        }
      }
      kctx.mocks = kctx.mocks.slice(1);
      return outputs;
    default:
      console.error("keploy is not in a valid mode");
      break;
  }
}

export function stringToBinary(input: string) {
  const characters = input.split("");
  const res = new Uint8Array(characters.length);

  characters.map(function (char, i) {
    const bit = char.charCodeAt(0);
    res[i] = bit;
  });
  return res;
}

function binaryToString(buf: Buffer) {
  let str = "";
  for (const value of buf.values()) {
    // to convert binary into JSON. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/fromCharCode
    str += String.fromCharCode(value);
  }
  return str;
}
export function toHttpHeaders(headers: { [key: string]: StrArr }) {
  const res: { [key: string]: string[] | undefined } = {};
  for (const k in headers) {
    res[k] = headers[k].Value;
  }
  return res;
}
