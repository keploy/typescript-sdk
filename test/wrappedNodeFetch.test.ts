import { wrappedNodeFetch } from '../integrations/octokit/require';
import { Response } from 'node-fetch';
import fetch from 'node-fetch';
import { createExecutionContext, getExecutionContext} from '../src/context';
import { HTTP } from '../src/keploy';

describe('wrappedNodeFetch', () => {
  it('should call fetch function with correct arguments in record mode', async () => {
    const ctx = {
      mode: 'record',
      testId: 'testId',
      mocks: [],
      deps: [],     
    };
    createExecutionContext(ctx)
    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({ fetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    const updatedctx= getExecutionContext().context;
    const responseBody = await response.text();
    const recordedOutput = updatedctx.mocks[0].Spec.Res.Body;
    expect(response).toBeInstanceOf(Response);
    expect(updatedctx.mocks.length).toBeGreaterThan(0);
    expect(updatedctx.deps.length).toBeGreaterThan(0);
    expect(response).toHaveProperty('body');
    expect(responseBody).toEqual(recordedOutput);
  });

   it('should return mocked response in test mode', async () => {
    const mockResponse = new Response('mocked response');
    const ctx = {
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
    createExecutionContext(ctx)

    const wrappedFetch = (wrappedNodeFetch(fetch) as any).bind({ fetch });
    const url = 'https://api.keploy.io/healthz';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    const updatedctx= getExecutionContext().context;
    expect(response.status).toEqual(mockResponse.status);
    expect(response.statusText).toEqual(mockResponse.statusText);

    const mocks=updatedctx.mocks.length;
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

  it('should call fetch function with correct arguments in off mode', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce(new Response());
    const ctx = {
      context: 'off',
      testId: 'testId',
      mocks: [],
      deps: [],
    };
    createExecutionContext(ctx)

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