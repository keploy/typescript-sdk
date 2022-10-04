import { getExecutionContext } from "./context";

export const MODE_RECORD = "record",
  MODE_TEST = "test",
  MODE_OFF = "off";
// Mode represents the mode at which the SDK is operating
// MODE_RECORD is for recording API calls to generate testcases
// MODE_TEST is for testing the application on previous recorded testcases
// MODE_OFF disables keploy SDK automatically from the application
//
// By default mode is set to off.
export default class Mode {
  mode: string;

  constructor() {
    this.mode = "off";
  }

  // Valid checks if the provided mode is valid
  static Valid(m: string): boolean {
    if (m == MODE_RECORD || m == MODE_TEST || m == MODE_OFF) {
      return true;
    }
    return false;
  }
  // GetMode returns the mode of the keploy SDK
  GetMode() {
    return this.mode;
  }
  // SetTestMode sets the keploy SDK mode to MODE_TEST
  SetTestMode() {
    this.SetMode("test");
  }

  // SetMode sets the keploy SDK mode
  // error is returned if the mode is invalid
  SetMode(m: string) {
    if (!Mode.Valid(m)) {
      return new Error("invalid mode: " + m);
    }
    this.mode = m;
  }
  // GetModeFromContext returns the mode on which SDK is configured by accessing environment variable.
  GetModeFromContext() {
    const kctx = getExecutionContext();
    if (
      getExecutionContext() == undefined ||
      getExecutionContext().context == undefined ||
      getExecutionContext().context.keployContext == undefined
    ) {
      return MODE_OFF;
    }
    return kctx.Mode;
  }
}
