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

  post(
    requestUrl: string,
    body: string,
    searchParams?: Record<string, string | number | boolean | undefined>
  ) {
    this.options = {
      body,
      url: requestUrl,
      method: "POST",
      headers: this.headers,
      responseType: "json",
      searchParams,
    };

    return this;
  }

  delete(
    requestUrl: string,
    body?: string,
    searchParams?: Record<string, string | number | boolean | undefined>
  ) {
    this.options = {
      body,
      url: requestUrl,
      method: "DELETE",
      headers: this.headers,
      searchParams,
    };

    return this;
  }

  put(
    requestUrl: string,
    body?: string,
    searchParams?: Record<string, string | number | boolean | undefined>
  ) {
    this.options = {
      body,
      url: requestUrl,
      method: "PUT",
      headers: this.headers,
      responseType: "json",
      searchParams,
    };

    return this;
  }

  patch(
    requestUrl: string,
    body?: string,
    searchParams?: Record<string, string | number | boolean | undefined>
  ) {
    this.options = {
      body,
      url: requestUrl,
      method: "PATCH",
      headers: this.headers,
      responseType: "json",
      searchParams,
    };

    return this;
  }

  create(
    requestMethod: "get" | "post" | "delete" | "patch" | "put",
    requestUrl: string,
    body: string
  ) {
    if (requestMethod.toLowerCase() === "get") {
      return this.get(requestUrl);
    } else if (requestMethod.toLowerCase() === "delete") {
      return this.delete(requestUrl, body);
    } else if (requestMethod.toLowerCase() === "put") {
      return this.put(requestUrl, body);
    } else if (requestMethod.toLowerCase() === "patch") {
      return this.patch(requestUrl, body);
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
    const resp: Response<T> = await http(options);
    return resp;
  }
}
