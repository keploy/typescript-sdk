import http, { Headers, OptionsOfJSONResponseBody } from "got";

export class Request {
  headers: Headers;
  options: OptionsOfJSONResponseBody;

  constructor() {
    this.headers = { "User-Agent": "keploy-typescript-sdk" };
    this.options = {};
  }

  setHttpHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  get(requestUrl: string) {
    this.options = {
      url: requestUrl,
      method: "GET",
      headers: this.headers,
      responseType: "json",
    };

    return this;
  }

  post(requestUrl: string, body: Buffer) {
    this.options = {
      body,
      url: requestUrl,
      method: "POST",
      headers: this.headers,
      responseType: "json",
    };

    return this;
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

  async makeHttpRequest(request: Request) {
    return http(request.raw()).buffer();
  }
}
