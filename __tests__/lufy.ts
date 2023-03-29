import { wrappedNodeFetch } from '../integrations/octokit/require';
import { Response } from 'node-fetch';
import fetch from 'node-fetch';
import { createExecutionContext, getExecutionContext } from '../src/context';
import { HTTP } from '../src/keploy';

describe('wrappedNodeFetch', () => {




  //  mode - recoed , url used - https://api.keploy.io/healthz
  // The test creates an execution context object with the mode set to "record", a test ID, an empty array for mocks, and an empty array for dependencies. It then calls the createExecutionContext function with this context object to set up the test environment.

  it('should invoke the fetch method in record mode with the appropriate parameters', async () => {
    // Set up the test context with mode, testId, mocks, and deps
    const context = {
      mode: 'record',
      testId: 'testId',
      mocks: [],
      deps: [],
    };
    // Call the createExecutionContext function with the test context to set up the environment
    createExecutionContext(context)
    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({ fetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    // Get the updated context and extract the response body and recorded output from the mock
    const updatedcontext = getExecutionContext().context;
    const responseBody = await response.text();
    const recordedOutput = updatedcontext.mocks[0].Spec.Res.Body;
    // Check that the response is an instance of the Response class, has a body property, and that the body matches the recorded output
    expect(response).toBeInstanceOf(Response);
    expect(updatedcontext.mocks.length).toBeGreaterThan(0);
    expect(updatedcontext.deps.length).toBeGreaterThan(0);
    expect(response).toHaveProperty('body');
    expect(responseBody).toEqual(recordedOutput);
  });

  //  mode - test , url used - https://api.keploy.io/healthz

  it('should return mocked response in test mode', async () => {
    const mockResponse = new Response('mocked response');
    // Set up the test context with mode, testId, mocks, and deps
    const context = {
      mode: 'test',
      testId: 'testId',
      mocks: [
        {
          Version: 'V1_BETA2',
          Name: 'testId',
          Kind: HTTP,
          Spec: {
            Metadata: {
              name: 'node-fetch',
              url: 'https://api.keploy.io/healthz',
              options: { method: 'GET' },
              type: 'HTTP_CLIENT',
            },
            Req: {
              URL: 'https://api.keploy.io/healthz',
              Body: '',
              Header: {},
              Method: 'GET',
            },
            Res: {
              StatusCode: 200,
              Header: { 'content-type': { Value: ['text/plain'] } },
              Body: 'mocked response',
            },
          },
        },
      ],
      deps: [],

    };
    createExecutionContext(context)

    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({ fetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    const updatedcontext = getExecutionContext().context;
    expect(response.status).toEqual(mockResponse.status);
    expect(response.statusText).toEqual(mockResponse.statusText);

    const mocks = updatedcontext.mocks.length;
    expect(mocks).toBe(0);
  });

  it('should return undefined if execution context is not present in record mode', async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response());
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    expect(consoleSpy).toHaveBeenCalledWith('keploy context is not present to mock dependencies');
    expect(response).toBeUndefined();
  });

  //  mode - off , url used - https://api.keploy.io/healthz

  it('should call fetch function with correct arguments in off mode', async () => {
    // Set up the test context with mode, testId, mocks, and deps
    const mockFetch = jest.fn().mockResolvedValueOnce(new Response());
    const context = {
      context: 'off',
      testId: 'testId',
      mocks: [],
      deps: [],
    };
    createExecutionContext(context)

    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);

    expect(mockFetch).toHaveBeenCalledWith(url, options);
    expect(response).toBeInstanceOf(Response);
  });
});