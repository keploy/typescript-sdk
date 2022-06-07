import got from "got";
import http, { Headers, OptionsOfJSONResponseBody, Response } from "got";

export class Request {
  headers: Headers;
  options: OptionsOfJSONResponseBody;

  constructor() {
    this.headers = { "User-Agent": "keploy-typescript-sdk" };
    this.options = {};
  }

  setHttpHeader(key: string, value: string) {
    this.headers[key] = value;
    return this;
  }
  setHttpHeaders(header: { [key: string]: string[] }) {
    for (const key in header) {
      if (header[key].length == 1) {
        this.headers[key] = header[key][0];
      } else {
        this.headers[key] = header[key];
      }
    }
    return this;
  }

  get(
    requestUrl: string,
    searchParams?: Record<string, string | number | boolean | undefined>
  ) {
    this.options = {
      url: requestUrl,
      method: "GET",
      headers: this.headers,
      responseType: "json",
      searchParams,
    };

    return this;
  }

  post(requestUrl: string, body: string) {
    this.options = {
      body,
      url: requestUrl,
      method: "POST",
      headers: this.headers,
      responseType: "json",
    };

    return this;
  }

  create(requestMethod: "get" | "post", requestUrl: string, body: string) {
    if (requestMethod.toLowerCase() === "get") {
      return this.get(requestUrl);
    } else {
      return this.post(requestUrl, body);
    }
  }

  raw() {
    return this.options;
  }
}

export default class HttpClient {
  baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async makeHttpRequest<T>(request: Request): Promise<T> {
    const options = { ...request.raw(), prefixUrl: this.baseUrl };
    return http(options).json();
  }

  async makeHttpRequestRaw<T>(request: Request): Promise<Response<T>> {
    const options = { ...request.raw(), prefixUrl: this.baseUrl };
    console.log("-> options :");
    const x: Promise<Response<T>> = http(options);
    console.log("-> after: ");
    return x;
  }

  async gotHandler(request: Request, header: { [key: string]: string[] }) {
    const options = { ...request.raw(), prefixUrl: this.baseUrl };
    // options.headers.foo;
    // for (const key in header) {
    //   if (header[key].length == 1) {
    //     options.headers[key] = header[key][0];
    //   } else {
    //     options.headers[key] = header[key];
    //   }
    // }
    if (options.headers != null) {
      options.headers = header;
      console.log(" request headers -> ", options.headers);
    }
    console.log(" --->", options);
    const x = await got(options);
    console.log("got call -> ", x);
  }
}
