import { response } from "express";
import { Mock } from "../proto/services/Mock";
import { getExecutionContext } from "../src/context";
import { grpcClient, MockIds, mockPath } from "./mock";

export function putMocks(mock: Mock) {
  const ctx = getExecutionContext().context
  grpcClient.PutMock({ Path: mockPath, Mock: mock, Remove:ctx.Remove, Replace:ctx.Replace }, (err, response) => {
    if (err !== null) {
      console.error(err);
    }
    if (response?.Inserted !== undefined && response?.Inserted.greaterThan(0)) {
      console.log(
        "🟠 Captured the mocked outputs for Http dependency call with meta: ",
        mock.Spec?.Metadata
      );
    }
  });
}

export function startRecordingMocks(
  path: string,
  mode: string,
  name: string,
  mockId: string
) {
  grpcClient.StartMocking(
    {
      Mode: mode,
      Path: path,
    },
    function (err, response) {
      if (err !== null) {
        console.error("failed to start mocking due to error: ", err);
        return;
      }
      if (response?.Exists) {
        console.log(
          "🚨 Keploy failed to record dependencies because yaml file already exists",
          name,
          " in directory: ",
          path,
          ".\n"
        );
        MockIds[mockId] = true;
      }
    }
  );
}
