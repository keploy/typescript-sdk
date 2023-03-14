/* eslint-disable @typescript-eslint/no-explicit-any */
import { getExecutionContext } from "../../src/context";
import { NO_SQL } from "../../src/keploy";
import { MODE_OFF, MODE_RECORD, MODE_TEST } from "../../src/mode";
import { ProcessDep } from "../../src/util";

// @ts-ignore
export function kUpdateOne(...args) {
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error(
      "keploy context is not present to mock updateOne dependency call"
    );
    // @ts-ignore
    this.col.prototype.updateOne.apply(this, args);
    return;
  }
  // fetch the keploy context for API requests
  const ctx = getExecutionContext().context;
  const meta: { [key: string]: string } = {
    name: "updateOne",
    filter: JSON.stringify(args[0]),
    update: JSON.stringify(args[1]),
    type: NO_SQL,
  };

  switch (ctx.mode) {
    case MODE_RECORD:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // wrap callback of updateOne to capture the mongodb-native-driver outputs
          // @ts-ignore
          args[args.length - 1] = function (...outputs) {
            ProcessDep(meta, ...outputs);
            // calls the actual mongoose callback for findOne
            callback.apply(this, outputs);
          };
        }
      }
      // @ts-ignore
      this.col.prototype.updateOne.apply(this, args);
      break;
    case MODE_TEST:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // mocked outputs of updateOne opperation
          const outputs: any[] = [null, {}];
          const mocks = ProcessDep(meta, ...outputs);
          // calls the actual mongoose callback for findOne
          // @ts-ignore
          callback.apply(this, mocks);
        }
      }
      break;
    case MODE_OFF:
      // call the actual updateOne operation
      // @ts-ignore
      this.col.prototype.updateOne.apply(this, args);
      break;
    default:
      console.debug(
        `keploy mode '${ctx.mode}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
      );
      // @ts-ignore
      this.col.prototype.updateOne.apply(this, args);
      break;
  }
}

// @ts-ignore
export function kUpdateMany(...args) {
  // checks for the keploy executionContext
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error(
      "keploy context is not present to mock updateMany dependency call"
    );
    // @ts-ignore
    this.col.prototype.updateMany.apply(this, args);
    return;
  }

  // fetch the keploy context for API requests
  const ctx = getExecutionContext().context;
  const meta: { [key: string]: string } = {
    name: "updateMany",
    filter: JSON.stringify(args[0]),
    updates: JSON.stringify(args[1]),
    type: NO_SQL,
  };
  switch (ctx.mode) {
    case MODE_RECORD:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // wrap callback of updateMany to capture the mongodb-native-driver outputs
          // @ts-ignore
          args[args.length - 1] = function (...outputs) {
            ProcessDep(meta, ...outputs);
            // calls the actual mongoose callback for findOne
            callback.apply(this, outputs);
          };
        }
      }
      // @ts-ignore
      this.col.prototype.updateMany.apply(this, args);
      break;
    case MODE_TEST:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // mocked outputs of updateMany opperation
          const outputs: any[] = [null, {}];
          const mocks = ProcessDep(meta, ...outputs);
          // calls the actual mongoose callback for findOne
          // @ts-ignore
          callback.apply(this, mocks);
        }
      }
      break;
    case MODE_OFF:
      // call the actual updateMany operation
      // @ts-ignore
      this.col.prototype.updateMany.apply(this, args);
      break;
    default:
      console.debug(
        `keploy mode '${ctx.mode}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
      );
      // @ts-ignore
      this.col.prototype.updateMany.apply(this, args);
      break;
  }
}
