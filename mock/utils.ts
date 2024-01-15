import { Mock } from "../proto/services/Mock";
import { grpcClient, MockIds, mockPath } from "./mock";

export function putMocks(mock: Mock) {
  grpcClient.PutMock({ Path: mockPath, Mock: mock }, (err, response) => {
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
  mockId: string,
  resolve: (value: string | PromiseLike<string>) => void,
  reject: (reason?: string) => void
) {
  grpcClient.StartMocking(
    {
      Mode: mode,
      Path: path,
    },
    function (err, response) {
      if (err !== null) {
        console.error("failed to start mocking due to error: ", err);
        reject(`failed to start mocking due to error: ${err}`);
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
      resolve("Passed");
    }
  );
}
