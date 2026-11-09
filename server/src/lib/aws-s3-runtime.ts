import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let s3Sdk: typeof import("@aws-sdk/client-s3") | undefined;

// Local-disk storage and non-AWS secret providers do not need the AWS SDK.
export function getS3Sdk(): typeof import("@aws-sdk/client-s3") {
  return s3Sdk ??= require("@aws-sdk/client-s3") as typeof import("@aws-sdk/client-s3");
}
