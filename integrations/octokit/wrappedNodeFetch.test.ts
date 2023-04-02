import { describe, it, expect, jest } from "@jest/globals";
import { createExecutionContext, getExecutionContext } from "../../src/context";
import fetch, { Response } from "node-fetch";
import { wrappedNodeFetch } from "./require";
import { HTTP } from "../../src/keploy";

describe("test for wrappedNodeFetch", () => {
  it("should call fetch function in the record mode with proper agent", async () => {
    const ctx = {
      mode: "record",
      testId: "test-1",
      mocks: [],
      deps: [],
    };
    createExecutionContext(ctx);
    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({
      fetch: fetch,
    });
    const options = {
      method: "GET",
    };
    const url = "https://www.reqres.in/api/users/2";
    const resp = await wrappedFetch(url, options);
    const responseBody = await resp.json();
    const updatedCtx = getExecutionContext().context;
    const output = updatedCtx.mocks[0].Spec.Res.Body;

    expect(fetch).toHaveBeenCalled();
    expect(resp).toHaveProperty("body");
    expect(resp).toBeInstanceOf(Response);
    expect(updatedCtx.mocks[0].Spec.Metadata.options).toEqual(options);
    expect(updatedCtx.mocks.length).toBeGreaterThan(0);
    expect(responseBody).toEqual(output);
  });

  it("should return the correct response in test mode", async () => {
    const capturedResponse = new Response("captured");
    const ctx = {
      mode: "test",
      testId: "test-1",
      mocks: [
        {
          Version: "V1_BETA2",
          Name: "test-1",
          Kind: HTTP,
          Spec: {
            Metadata: {
              name: "node-fetch",
              url: "https://www.reqres.in/api/users/2",
              options: { method: "GET" },
              type: "HTTP_CLIENT",
            },
            Req: {
              URL: "https://www.reqres.in/api/users/2",
              Body: "",
              Header: {},
              Method: "GET",
            },
            Res: {
              Header: { "content-type": "application/json" },
              Body: "captured",
              StatusCode: 200,
            },
          },
        },
      ],
      deps: [],
    };
    createExecutionContext(ctx);
    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({ fetch });
    const url = "https://www.reqres.in/api/users/2";
    const options = {
      method: "GET",
    };
    const resp = await wrappedFetch(url, options);
    const updatedCtx = getExecutionContext().context;

    expect(resp.status).toEqual(capturedResponse.status);
    expect(resp.statusText).toEqual(capturedResponse.statusText);
    expect(updatedCtx.mocks.length).toBe(0);
  });

  it("should return undefined if the context execution is not present in test mode", async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response());
    const spyConsole = jest.spyOn(console, "error").mockImplementation;
    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({
      fetch: mockFetch,
    });
    const url = "https://www.reqres.in/api/users/2";
    const options = {
      method: "GET",
    };
    const resp = await wrappedFetch(url, options);

    expect(resp).toBeUndefined();
    expect(spyConsole).toHaveBeenCalledWith(
      "keploy context is not present to mock dependencies"
    );
  });

  it("should call fetch function with proper arguments in off mode", async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response());
    const ctx = {
      mode: "off",
      testId: "test-1",
      mocks: [],
      deps: [],
    };
    createExecutionContext(ctx);
    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({
      fetch: mockFetch,
    });
    const url = "https://www.reqres.in/api/users/2";
    const options = {
      method: "GET",
    };
    const resp = await wrappedFetch(url, options);

    expect(resp).toBeInstanceOf(Response);
    expect(mockFetch).toHaveBeenCalledWith(url, options);
  });
});
