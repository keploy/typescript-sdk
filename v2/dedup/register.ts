// @ts-ignore
import Hook from "require-in-the-middle";
import expressMiddleware from "./middleware";
import bodyParser from "body-parser";
import cors from "cors";

const _ = require('lodash');
const khook = "keployWrappedExpress";
// @ts-ignore
Hook(["express"], function (exports) {
  // console.log("Inside keploy hook...");
  const expressApp = exports;
  function keployWrappedExpress() {
    const keployApp = expressApp();

    keployApp.use(bodyParser.json());
    keployApp.use(cors());
    keployApp.use(expressMiddleware());
    keployApp.appliedMiddleware = true;
    return keployApp;
  }
  
  // copy the properties and methods of exported Function object into wrapped Funtion(keployWrappedExpress).
  // In order to prevent "express._Method_ or express._Field_ is not declared" error.
  // mixin(keployWrappedExpress, expressApp, false);
  _.assign(keployWrappedExpress, expressApp);
  exports = keployWrappedExpress;
  return exports;
});
export { khook };
