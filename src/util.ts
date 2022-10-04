/* eslint-disable @typescript-eslint/no-explicit-any */

import { DataBytes } from "../proto/services/DataBytes";
import { StrArr } from "../proto/services/StrArr";
import { getExecutionContext } from "./context";

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

export function ProcessDep(meta: { [key: string]: string }, outputs: any[]) {
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error("keploy context is not present to mock dependencies");
    return;
  }
  const kctx = getExecutionContext().context;
  switch (kctx.mode) {
    case "record":
      const res: DataBytes[] = [];
      for (let i = 0; i < outputs.length; i++) {
        res.push({ Bin: stringToBinary(JSON.stringify(outputs[i])) });
      }
      kctx.deps.push({
        Name: meta.name,
        Type: meta.type,
        Meta: meta,
        Data: res,
      });
      break;
    case "test":
      if (kctx.deps == undefined || kctx.deps.length == 0) {
        console.error(
          "dependency failed: incorrect number of dependencies in keploy context. test id: %s",
          kctx.testID
        );
        return;
      }
      if (outputs.length !== kctx.deps[0].Data.length) {
        console.error(
          "dependency failed: incorrect number of dependencies in keploy context. test id: %s",
          kctx.testID
        );
        return;
      }

      for (let i = 0; i < outputs.length; i++) {
        outputs[i] = JSON.parse(binaryToString(kctx.deps[0].Data[i].Bin));
      }
      kctx.deps = kctx.deps.slice(1);
      break;
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
  // let str = "";
  // bin.map(function (el) {
  //   str += String.fromCharCode(el);
  // });
  // return str;
  return buf.toString();
}

export function toHttpHeaders(headers: { [key: string]: StrArr }) {
  const res: { [key: string]: string[] | undefined } = {};
  for (const k in headers) {
    res[k] = headers[k].Value;
  }
  return res;
}
