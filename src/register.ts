// @ts-ignore
import Hook from "require-in-the-middle";

// @ts-ignore
Hook(["express"], function (exports) {
  const expressApp = exports;

  function keployWrappedExpress() {
    const keployApp = expressApp();

    // @ts-ignore
    keployApp.use("*", (req, res, next) => {
      console.log(req.path);
      next();
    });
    keployApp.hijacked = true;

    return keployApp;
  }

  exports = keployWrappedExpress;
  return exports;
});
