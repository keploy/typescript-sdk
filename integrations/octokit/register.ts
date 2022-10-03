/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable prefer-rest-params */
import Hook from "import-in-the-middle";
import mixin from "merge-descriptors";
import { wrappedNodeFetch } from "./require";
console.log("hook for octokit in import", Hook)
// @ts-ignore
Hook(["octokit"], (exported, name: any, baseDir: any) => {
  const octokitDefault = exported.default;
  exported.Octokit = class WrappedOctokit {
    constructor(props: { request: { fetch: any; } | undefined; }) {
      console.log("logs from octokit....")
      const wrappedFetch = wrappedNodeFetch();

      if (props.request != undefined) {
        props.request.fetch = wrappedFetch;
      } else {
        props.request = {
          fetch: wrappedFetch,
        };
      }
      const octo = new octokitDefault.Octokit(props);
      mixin(this, octo, false);
    }
  };
  exported.default.Octokit = exported.Octokit
  // exported.default = octokitDefault;
});