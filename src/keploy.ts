type AppConfigFilter = {
  urlRegex: string
}

type AppConfig = {
  name: string,
  host: string,
  port: number,
  delay: number,
  timeout: number,
  filter: AppConfigFilter
}

type ServerConfig = {
  url: string,
  licenseKey: string
}

type ID = string

type HttpResponse = any

type HttpRequest = any

type TestCase = any

type TestCaseRequest = any

export default class Keploy {
  constructor(app: AppConfig, server: ServerConfig) {
    throw new Error("Not implemented")
  }

  getDependencies(id: ID) {
    throw new Error("Not implemented")
  }

  getResp(id: ID) {
    throw new Error("Not implemented")
  }

  putResp(id: ID, resp: HttpResponse) {
    throw new Error("Not implemented")
  }

  capture(req: TestCaseRequest) {
    throw new Error("Not implemented")
  }

  test() {
    throw new Error("Not implemented")
  }

  get() {
    throw new Error("Not implemented")
  }

  private start(total: number) {
    throw new Error("Not implemented")
  }

  private end(id: ID, status: boolean) {
    throw new Error("Not implemented")
  }

  private simulate(tc: TestCase) {
    throw new Error("Not implemented")
  }

  private put(tcs: TestCaseRequest) {
    throw new Error("Not implemented")
  }

  private denoise(id: string, tcs: TestCaseRequest) {
    throw new Error("Not implemented")
  }

  private fetch() {
    throw new Error("Not implemented")
  }

  private setKey(req: HttpRequest) {
    throw new Error("Not implemented")
  }
}
