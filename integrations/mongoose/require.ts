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
      if (process.env.KEPLOY_MODE !== MODE_TEST) {
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
          `keploy mode '${process.env.KEPLOY_MODE}' is invalid. Modes: 'record' / 'test' / 'off'(default)`
        );
        return originalDriver.getConnection();
    }
  };
  exports = exports.setDriver(wrappedDriver);
  return exports;
});
