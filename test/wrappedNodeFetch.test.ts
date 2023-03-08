import { wrappedNodeFetch } from '../integrations/octokit/require';
import { Response } from 'node-fetch';
import { createExecutionContext } from '../src/context';
describe('wrappedNodeFetch', () => {
  it('should call fetch function with correct arguments in record mode', async () => {
    const mockFetch = jest.fn().mockResolvedValueOnce(new Response());
    const ctx = {
      context:{
      mode: 'record',
      testId: 'testId',
      mocks: [],
      deps: [],
      }
    };
    createExecutionContext(ctx)
    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'http://example.com';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    console.log(response,"RESPONSE")

    expect(mockFetch).toHaveBeenCalledWith(url, options);
    expect(response).toBeInstanceOf(Response);
  });

  it('should return mocked response in test mode', async () => {
    const mockResponse = new Response('mocked response');
    const mockFetch = jest.fn().mockResolvedValue(mockResponse);
    const ctx = {
      context:{
      mode: 'test',
      testId: 'testId',
      mocks: [
        {
          Version: 'V1_BETA2',
          Name: 'testId',
          Kind: 'HTTP',
          Spec: {
            Metadata: {
              name: 'node-fetch',
              url: 'http://example.com',
              options: { method: 'GET' },
              type: 'HTTP_CLIENT',
            },
            Req: {
              URL: 'http://example.com',
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
    }
    };
    createExecutionContext(ctx)

    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'http://example.com';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    console.log(response,"RESPONSE")
    expect(response).toEqual(mockResponse);
  });

  it('should return undefined if execution context is not present in record mode', async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response());
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'http://example.com';
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
      context:{
      context: 'off',
      testId: 'testId',
      mocks: [],
      deps: [],
      }
    };
    createExecutionContext(ctx)

    const wrappedFetch = (wrappedNodeFetch(mockFetch) as any).bind({ fetch: mockFetch });
    const url = 'http://example.com';
    const options = {
      method: 'GET',
    };
    const response = await wrappedFetch(url, options);
    console.log(response,"RESPONSE")

    expect(mockFetch).toHaveBeenCalledWith(url, options);
    expect(response).toBeInstanceOf(Response);
  });
});