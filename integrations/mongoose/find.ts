/* eslint-disable @typescript-eslint/no-explicit-any */
import { getExecutionContext } from "../../src/context";
import { NO_SQL } from "../../src/keploy";
import { MODE_OFF, MODE_RECORD, MODE_TEST } from "../../src/mode";
import { ProcessDep } from "../../src/util";

// @ts-ignore
export function kFindOne(...args) {
  // checks for the keploy executionContext
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error(
      "keploy context is not present to mock findOne dependency call"
    );
    // @ts-ignore
    this.col.prototype.findOne.apply(this, args);
    return;
  }

  // fetch the keploy context for API requests
  const ctx = getExecutionContext().context;
  const meta: { [key: string]: string } = {
    name: "findOne",
    filter: JSON.stringify(args[0]),
    type: NO_SQL,
  };

  switch (ctx.mode) {
    case MODE_RECORD:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // wrap callback of findOne to capture the mongodb-native-driver outputs
          // @ts-ignore
          args[args.length - 1] = function (...outputs) {
            ProcessDep(meta, ...outputs);
            // calls the actual mongoose callback for findOne
            callback.apply(this, outputs);
          };
        }
      }
      // calls the actual findOne operation with wrapped callback
      // @ts-ignore
      this.col.prototype.findOne.apply(this, args);
      break;
    case MODE_TEST:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // mocked outputs of findOne opperation
          const outputs: any[] = [null, {}];
          const mocks = ProcessDep(meta, ...outputs);
          // calls the actual mongoose callback for findOne
          // @ts-ignore
          callback.apply(this, mocks);
        }
      }
      break;
    case MODE_OFF:
      // call the actual findOne operation
      // @ts-ignore
      this.col.prototype.findOne.apply(this, args);
      break;
    default:
      console.debug(
        `keploy mode '${ctx.mode}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
      );
      // @ts-ignore
      this.col.prototype.findOne.apply(this, args);
      break;
  }
}

// @ts-ignore
export function kFind(...args) {
  // checks for the keploy executionContext
  if (
    getExecutionContext() == undefined ||
    getExecutionContext().context == undefined
  ) {
    console.error("keploy context is not present to mock find dependency call");
    // @ts-ignore
    this.col.prototype.find.apply(this, args);
    return;
  }

  // fetch the keploy context for API requests
  const ctx = getExecutionContext().context;
  const meta: { [key: string]: string } = {
    name: "find",
    filter: JSON.stringify(args[0]),
    type: NO_SQL,
  };

  switch (ctx.mode) {
    case MODE_RECORD:
      {
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // wrap callback of find to capture the mongodb-native-driver outputs
          args[args.length - 1] = function (...outputs: any) {
            if (outputs[1] !== undefined) {
              const actualToArray = outputs[1].toArray;

              // wrap the toArray method mongoDB cursor to capture documents
              // @ts-ignore
              outputs[1].toArray = async function (cb) {
                // call the actual toArray method of cursor
                const result = await actualToArray.apply(outputs[1], cb);
                // encode and stores the documents in executionContext
                ProcessDep(meta, outputs[0], result);
                // calls the actual user defined callback
                cb(outputs[0], result);
                return result;
              };
            }
            // calls the actual mongoose callback for find
            callback.apply(this, outputs);
          };
        }
      }

      // calls the actual find operation with wrapped callback
      // @ts-ignore
      this.col.prototype.find.apply(this, args);
      break;
    case MODE_TEST:
      {
        // fetch the callback for find operation
        const callback = args[args.length - 1];
        if (typeof callback === "function") {
          // mocked outputs of find opperation
          const outputs = [null, {}];
          let result: any[] = [];
          // returns the mocked outputs of find call
          const mocks = ProcessDep(meta, outputs[0], result);
          if (mocks !== undefined && mocks.length == 2) {
            result = mocks[1];
            outputs[0] = mocks[0];
          }
          // @ts-ignore
          outputs[1].toArray = async function (cb) {
            // call user defined cb with decoded mocked outputs
            cb(outputs[0], result);
            return result;
          };
          // call the mongoose callback with mocked outputs
          // @ts-ignore
          callback.apply(this, outputs);
        }
      }
      break;
    case MODE_OFF:
      // call the actual find operation
      // @ts-ignore
      this.col.prototype.find.apply(this, args);
      break;
    default:
      console.debug(
        `keploy mode '${ctx.mode}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
      );
      // @ts-ignore
      this.col.prototype.find.apply(this, args);
      break;
  }
}
