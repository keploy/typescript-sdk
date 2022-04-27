import * as http from "http";
import { URL } from "url";

export interface WrappedFunction extends Function {
  [key: string]: any;
  __keploy_wrapped__?: WrappedFunction;
  __keploy_original__?: WrappedFunction;
}

export function markFunctionWrapped(
  wrapped: WrappedFunction,
  original: WrappedFunction
): void {
  const proto = original.prototype || {};
  wrapped.prototype = original.prototype = proto;
  addNonEnumerableProperty(wrapped, "__keploy_original__", original);
}

export function addNonEnumerableProperty(
  obj: { [key: string]: unknown },
  name: string,
  value: unknown
): void {
  Object.defineProperty(obj, name, {
    value: value,
    writable: true,
    configurable: true,
  });
}

export function fill(
  source: Record<string, WrappedFunction>,
  name: string,
  replacementFactory: (arg: WrappedFunction) => WrappedFunction
): void {
  if (!(name in source)) {
    return;
  }

  const original = source[name];
  const wrapped = replacementFactory(original);

  if (typeof wrapped === "function") {
    try {
      markFunctionWrapped(wrapped, original);
    } catch (ex) {
      // This can throw if multiple fill happens on a global object like XMLHttpRequest
    }
  }

  source[name] = wrapped;
}

function urlToOptions(url: URL): RequestOptions {
  const options: RequestOptions = {
    protocol: url.protocol,
    hostname:
      typeof url.hostname === "string" && url.hostname.startsWith("[")
        ? url.hostname.slice(1, -1)
        : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  if (url.port !== "") {
    options.port = Number(url.port);
  }
  if (url.username || url.password) {
    options.auth = `${url.username}:${url.password}`;
  }
  return options;
}

type RequestOptions = http.RequestOptions & {
  hash?: string;
  search?: string;
  pathname?: string;
  href?: string;
};

type RequestCallback = (response: http.IncomingMessage) => void;

type RequestMethodArgs =
  | [RequestOptions | string | URL, RequestCallback?]
  | [string | URL, RequestOptions, RequestCallback?];

type RequestMethod = (...args: RequestMethodArgs) => http.ClientRequest;

export function extractUrl(requestOptions: RequestOptions): string {
  const protocol = requestOptions.protocol || "";
  const hostname = requestOptions.hostname || requestOptions.host || "";
  // Don't log standard :80 (http) and :443 (https) ports to reduce the noise
  const port =
    !requestOptions.port ||
    requestOptions.port === 80 ||
    requestOptions.port === 443
      ? ""
      : `:${requestOptions.port}`;
  const path = requestOptions.path ? requestOptions.path : "/";

  return `${protocol}//${hostname}${port}${path}`;
}

export function normalizeRequestArgs(
  requestArgs: RequestMethodArgs
): [RequestOptions] | [RequestOptions, RequestCallback] {
  let callback, requestOptions;

  // pop off the callback, if there is one
  if (typeof requestArgs[requestArgs.length - 1] === "function") {
    callback = requestArgs.pop() as RequestCallback;
  }

  // create a RequestOptions object of whatever's at index 0
  if (typeof requestArgs[0] === "string") {
    requestOptions = urlToOptions(new URL(requestArgs[0]));
  } else if (requestArgs[0] instanceof URL) {
    requestOptions = urlToOptions(requestArgs[0]);
  } else {
    requestOptions = requestArgs[0];
  }

  // if the options were given separately from the URL, fold them in
  if (requestArgs.length === 2) {
    requestOptions = { ...requestOptions, ...requestArgs[1] };
  }

  // return args in standardized form
  if (callback) {
    return [requestOptions, callback];
  } else {
    return [requestOptions];
  }
}

function hijackHttpModule() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const httpModule = require("http");
  //@ts-ignore
  fill(httpModule, "get", wrappedRequestMethodFactory);
  //@ts-ignore
  fill(httpModule, "request", wrappedRequestMethodFactory);
}

type OriginalRequestMethod = RequestMethod;
type WrappedRequestMethod = RequestMethod;

function wrappedRequestMethodFactory(
  originalRequestMethod: OriginalRequestMethod
): WrappedRequestMethod {
  return function wrappedMethod(
    ...args: RequestMethodArgs
  ): http.ClientRequest {
    // eslint-disable-next-line @typescript-eslint/no-this-alias

    const requestArgs = normalizeRequestArgs(args);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const httpModule = require("http");
    const requestOptions = requestArgs[0];
    const requestUrl = extractUrl(requestOptions);

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return originalRequestMethod
      .apply(httpModule, requestArgs)
      .once(
        "response",
        function (req: http.ClientRequest, res: http.IncomingMessage): void {
          // eslint-disable-next-line @typescript-eslint/no-this-alias
          console.log(req, res);
        }
      )
      .once("error", function (req: http.ClientRequest): void {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        console.log(req);
      });
  };
}
