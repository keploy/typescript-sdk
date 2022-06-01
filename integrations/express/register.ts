// @ts-ignore
import Hook from "require-in-the-middle";
import expressMiddleware from "./middleware";
import Keploy from "../../src/keploy";

// @ts-ignore
Hook(["express"], function (exports) {
  const expressApp = exports;

  function keployWrappedExpress() {
    const keployApp = expressApp();

    const keploy = new Keploy();

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
