// @ts-ignore
import Hook from "require-in-the-middle";
import expressMiddleware from "./middleware";

// @ts-ignore
Hook(["express"], function (exports) {
  const expressApp = exports;

  function keployWrappedExpress() {
    const keployApp = expressApp();

    keployApp.use(expressMiddleware);
    keployApp.appliedMiddleware = true;

    return keployApp;
  }

  exports = keployWrappedExpress;
  return exports;
});
