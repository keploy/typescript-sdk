// @ts-ignore
import Hook from "require-in-the-middle";
import "zone.js";
import expressMiddleware from "./express/middleware";
import mongoosePlugin from "./mongoose/plugin";
import Keploy from "../src/keploy";

const keploy = new Keploy();

// @ts-ignore
Hook(["express"], function (exports) {
  const expressApp = exports;

  function keployWrappedExpress() {
    const keployApp = expressApp();

    keployApp.use(expressMiddleware(keploy));
    keployApp.appliedMiddleware = true;
    keployApp.on("listening", function () {
      keploy.create();
    });

    return keployApp;
  }

  exports = keployWrappedExpress;
  return exports;
});

// @ts-ignore
Hook(["mongoose"], function (exports) {
  exports.plugin(mongoosePlugin(keploy));
  return exports;
});
