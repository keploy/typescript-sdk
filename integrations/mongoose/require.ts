/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-ignore
import Hook from "require-in-the-middle";
import { MODE_RECORD, MODE_OFF, MODE_TEST } from "../../src/mode";
import EventEmitter from "events";
import { Collection1 } from "./collection";
import { kDeleteMany, kDeleteOne } from "./delete";
import { kUpdateMany, kUpdateOne } from "./update";
import { kInsertMany, kInsertOne } from "./insert";
import { kFind, kFindOne } from "./find";

// @ts-ignore
Hook(["mongoose"], function (exports) {
  const originalDriver = exports.driver.get();
  const wrappedDriver = Object.create(originalDriver);

  // wraps the mongo collection to mock dependency calls
  class kCollection extends originalDriver.Collection {
    // stores the actual collection to be mocked in record/off mode
    col: any;

    constructor(name: string, conn: any, options: any) {
      if (
        process.env.KEPLOY_MODE === MODE_RECORD ||
        process.env.KEPLOY_MODE === MODE_OFF
      ) {
        // contruct the actual mongoose collection and stores in col field
        super(name, conn, options);
        this.col = originalDriver.Collection;
      }
    }

    // @ts-ignore
    deleteOne(...args) {
      // calls the wrapper with this object binded
      kDeleteOne.apply(this, args);
    }

    // @ts-ignore
    updateOne(...args) {
      // calls the wrapper with this object binded
      kUpdateOne.apply(this, args);
    }

    // @ts-ignore
    insertOne(...args) {
      // calls the wrapper with this object binded
      kInsertOne.apply(this, args);
    }

    // findOne wraps the actual findOne mongoDB operation to mock/stub outputs
    // @ts-ignore
    findOne(...args) {
      // calls the wrapper with this object binded
      kFindOne.apply(this, args);
    }

    // find wraps the actual find mongoDB operation to mock/stub outputs
    // @ts-ignore
    find(...args) {
      // calls the wrapper with this object binded
      kFind.apply(this, args);
    }

    // @ts-ignore
    insertMany(...args) {
      // calls the wrapper with this object binded
      kInsertMany.apply(this, args);
    }

    // @ts-ignore
    updateMany(...args) {
      // calls the wrapper with this object binded
      kUpdateMany.apply(this, args);
    }

    // @ts-ignore
    deleteMany(...args) {
      // calls the wrapper with this object binded
      kDeleteMany.apply(this, args);
    }
  }
  // used setDriver to use custom driver in mongoose
  // Reference: https://github.com/Automattic/mongoose/blob/67919626d2c255cce16a0ed0de6bde316060094d/test/index.test.js#L1055
  wrappedDriver.Collection = kCollection;
  wrappedDriver.getConnection = () => {
    switch (process.env.KEPLOY_MODE) {
      case MODE_RECORD:
        const res = originalDriver.getConnection();
        return res;
      case MODE_TEST:
        // mock connection for mocking the mongoDB connection
        class Connection extends EventEmitter {
          base: any;
          models: any;
          readyState: any;
          // @ts-ignore
          constructor(base) {
            super();
            this.base = base;
            this.models = {};
          }

          // @ts-ignore
          collection() {
            return new Collection1();
          }

          // @ts-ignore
          openUri(uri, opts, callback) {
            this.readyState = exports.ConnectionStates.connected;
            callback();
          }
        }
        return Connection;
      case MODE_OFF:
        const resOff = originalDriver.getConnection();
        return resOff;
      default:
        console.debug(
          "mode is not valid. Please set valid keploy mode using env variables"
        );
        return originalDriver.getConnection();
    }
  };
  exports = exports.setDriver(wrappedDriver);
  return exports;
});

// Hook into the express and mongodb module
// @ts-ignore
// Hook(["mongoose"], function (exports, name) {
//   // during test mode, fake the mongodb connection by custom driver
//   if (process.env.KEPLOY_MODE === MODE_TEST) {
//     const originalDriver = exports.driver.get();
//     console.log("before loading the driver", exports.driver.get());

//     //   const wrappedDriver = Object.create(originalDriver);
//     const wrappedDriver = Object.create(originalDriver);
//     wrappedDriver.foo = "Ritik";
//     wrappedDriver.Collection = Collection1;
//     wrappedDriver.getConnection = () => {
//       return class Connection extends EventEmitter {
//         base: any;
//         models: any;
//         readyState: any;
//         // _originalConn: any;

//         // @ts-ignore
//         constructor(base) {
//           super();
//           this.base = base;
//           this.models = {};
//         }

//         // setOriginalConn(conn: any) {
//         //   this._originalConn = conn;
//         // }
//         collection() {
//           //   return originalDriver.Collection;
//           return new Collection1();
//         }

//         // @ts-ignore
//         openUri(uri, opts, callback) {
//           this.readyState = exports.ConnectionStates.connected;
//           callback();
//         }
//       };
//     };
//     exports = exports.setDriver(wrappedDriver);
//   }
//   //   const originalConnect = exports.connect;

//   //   // @ts-ignore
//   //   const wrappedConnect = function (...args) {
//   //     switch (process.env.KEPLOY_MODE) {
//   //       case MODE_RECORD:

//   //         break;
//   //       case MODE_TEST:
//   //         break;
//   //       case MODE_OFF:
//   //         break;
//   //       default:
//   //         console.debug(
//   //           "mode is not valid. Please set valid keploy mode using env variables"
//   //         );
//   //         return originalConnect.apply(exports, args);
//   //     }
//   //   };

//   console.log("loading", name, exports.model);

//   const originalModel = exports.model;
//   // @ts-ignore
//   const wrappedModel = function (...args) {
//     const resModel = originalModel.apply(exports, args);

//     const originalFind = resModel.find;
//     console.log("find method: ", originalFind);
//     // @ts-ignore
//     const wrappedFind = (...args) => {
//       if (
//         getExecutionContext() == undefined ||
//         getExecutionContext().context == undefined
//       ) {
//         console.error("keploy context is not present to mock dependencies");
//         return;
//       }
//       const meta: { [key: string]: string } = {
//         name: "mongo",
//         operation: "find",
//         type: "NO_SQL",
//         query: JSON.stringify(args),
//       };
//       const lastArgs = args[args.length - 1];
//       if (typeof lastArgs === "function") {
//         // @ts-ignore
//         const cb = new callback(meta, lastArgs);
//         cb.actualCallback = lastArgs;
//         cb.meta = meta;
//         args[args.length - 1] = cb;
//       }
//       const res = originalFind.apply(resModel, args);
//       const actualExec = res.exec;
//       // @ts-ignore
//       res.exec = function (...args) {
//         const lastArgs = args[args.length - 1];
//         if (typeof lastArgs === "function") {
//           // @ts-ignore
//           const cb = new callback(meta, lastArgs);
//           cb.actualCallback = lastArgs;
//           cb.meta = meta;
//           args[args.length - 1] = cb;
//         }
//         return actualExec.apply(res, args);
//       };

//       //   let res,
//       //     err = "nil";
//       //   const kctx = getExecutionContext().context;
//       //   console.log("context id: ", kctx);
//       //   switch (kctx.mode) {
//       //     case MODE_RECORD:
//       //       //   originalFind.call(resModel, args);
//       //         // res = originalFind.apply(resModel, args);
//       //       //   try {
//       //       //     res = await originalFind.apply(resModel, args);
//       //       //   } catch (error) {
//       //       //     err = JSON.stringify(error);
//       //       //   }
//       //       break;
//       //   }
//       //   const res = await originalFind.apply(resModel, args);
//       //   ProcessDep(meta, res, err);
//       //   console.log("res", res);
//       return res;
//     };
//     mixin(wrappedFind, originalFind, false);
//     resModel.find = wrappedFind;
//     return resModel;
//     // @ts-ignore
//     // resModel.find = function (...args) {
//     //     try {
//     //         const resp =
//     //     } catch (error) {

//     //     }
//     // };
//   };
//   mixin(wrappedModel, originalModel, false);
//   exports.model = wrappedModel;
//   // whatever you return will be returned by `require`
//   return exports;
// });

// // @ts-ignore
// function callback(meta, actualCallback) {
//   const kctx = getExecutionContext().context;
//   console.log("context id: ", kctx);
//   //   // @ts-ignore
//   //   this.meta = {};
//   //   // @ts-ignore
//   //   this.actualCallback = {};
//   // @ts-ignore
//   return function (...args) {
//     console.log("mocked callback", args);
//     ProcessDep(meta, ...args);
//     actualCallback(...args);
//     // switch (kctx.mode) {
//     //   case MODE_RECORD:
//     //     // @ts-ignore
//     //     this.actualCallback(...args);
//     //     break;
//     //   default:
//     //     break;
//     // }
//   };
// }
