import fetchMock, { MockResponse } from "fetch-mock";
import { wrappedNodeFetch } from "../integrations/octokit/require";
import { Response } from 'node-fetch';
import { createExecutionContext, getExecutionContext} from '../src/context';
import { HTTP } from '../src/keploy';

describe("wrappedNodeFetch", () => {
  afterEach(() => {
    fetchMock.restore();
  });

  it("should make a network request in record mode", async () => {
    const ctx = {
      mode: "record",
      testId: "test-id",
      mocks: [],
      deps: [],
    };
    const url = "https://api.github.com/repos/octocat/hello-world/issues/123";
    const options: RequestInit = {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: "token secret123",
      },
    };
    const fetchSpy = jest.spyOn(fetchMock, "default").mockReturnValue(
      Promise.resolve({
        status: 200,
        body: "Hello world!",
        headers: {
          "Content-Type": "text/plain",
        },
      })
    );

    const wrappedFetch = wrappedNodeFetch(fetchMock.default);

    await wrappedFetch.call({ fetch: fetchMock.default }, url, options);

    expect(fetchSpy).toHaveBeenCalledWith(url, {
      method: options.method,
      headers: options.headers,
    });

    expect(ctx.mocks).toHaveLength(1);

    const httpMock = ctx.mocks[0] as HTTP;
    expect(httpMock.Kind).toEqual("HTTP");
    expect(httpMock.Spec.Metadata.name).toEqual("node-fetch");
    expect(httpMock.Spec.Metadata.url).toEqual(url);
    expect(httpMock.Spec.Metadata.type).toEqual("HTTP_CLIENT");
    expect(httpMock.Spec.Metadata.options).toEqual(options);

    expect(httpMock.Spec.Req.Method).toEqual(options.method);
    expect(httpMock.Spec.Req.URL).toEqual(url);
    expect(httpMock.Spec.Req.Header).toEqual({
      "Content-Type": "application/json",
      Authorization: "token secret123",
    });
    expect(httpMock.Spec.Req.Body).toBeUndefined();

    expect(httpMock.Spec.Res.StatusCode).toEqual(200);
    expect(httpMock.Spec.Res.Header).toEqual({
      "Content-Type": "text/plain",
    });
    expect(httpMock.Spec.Res.Body).toEqual("Hello world!");
  });
});
