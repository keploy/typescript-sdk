/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import asyncHooks from "async_hooks";

const executionContextMap = new Map();

const asyncHook = asyncHooks.createHook({ init, destroy });
asyncHook.enable();

function init(asyncId: any, type: any, triggerAsyncId: any) {
  const parentContext = executionContextMap.get(triggerAsyncId);
  if (!parentContext) return;

  executionContextMap.set(asyncId, { context: parentContext.context });
}

function destroy(asyncId: any) {
  executionContextMap.delete(asyncId);
}

export function createExecutionContext(context: any) {
  const asyncId = asyncHooks.executionAsyncId();
  executionContextMap.set(asyncId, { context });
}

export function getExecutionContext() {
  const asyncId = asyncHooks.executionAsyncId();
  return executionContextMap.get(asyncId);
}

export function deleteExecutionContext() {
  const asyncId = asyncHooks.executionAsyncId();
  executionContextMap.delete(asyncId);
}
