import { response } from "express";
import { Mock } from "../proto/services/Mock";
import { grpcClient, mockPath } from "./mock";

export function putMocks(mock: Mock) {
  grpcClient.PutMock({ Path: mockPath, Mock: mock }, (err, response) => {
    if (err !== null) {
      console.error();
    }
    if (response?.Inserted !== undefined && response?.Inserted.greaterThan(0)) {
      console.log(
        "🟠 Captured the mocked outputs for Http dependency call with meta: ",
        mock.Spec?.Metadata
      );
    }
  });
}
