// @ts-ignore
import Hook from "require-in-the-middle";
import expressMiddleware from "./middleware";
import Keploy from "../../src/keploy";
import bodyParser from "body-parser";

// @ts-ignore
Hook(["express"], function (exports) {
  const expressApp = exports;

  function keployWrappedExpress() {
    const keployApp = expressApp();

    const keploy = new Keploy();
    keployApp.use(bodyParser.json());
    keployApp.use(expressMiddleware(keploy));
    keployApp.appliedMiddleware = true;
    keploy.create();
    return keployApp;
  }
  // copy the properties and methods of exported Function object into wrapped Funtion(keployWrappedExpress).
  // In order to prevent "express._Method_ or express._Field_ is not declared" error.
  // @ts-ignore
  for (const key in expressApp) {
    // @ts-ignore
    keployWrappedExpress[key] = expressApp[key];
  }
  exports = keployWrappedExpress;
  return exports;
});
