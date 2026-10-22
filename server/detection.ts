import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
export class DetectionError extends Error {
  constructor(readonly code: string) {
    super("Detection unavailable.");
  }
}
let active = 0;
export async function runDetection<T = unknown>(
  input: unknown,
  timeout = 1000,
): Promise<T> {
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json) > 16 * 1024 * 1024)
    throw new DetectionError("invalid_request");
  if (active >= 4) throw new DetectionError("execution_limit");
  active++;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolveResult, reject) => {
      worker = new Worker(resolve("dist/server/detection-worker.mjs"), {
        workerData: json,
        resourceLimits: {
          maxOldGenerationSizeMb: 28,
          maxYoungGenerationSizeMb: 4,
          stackSizeMb: 1,
        },
        stdout: true,
        stderr: true,
      });
      timer = setTimeout(
        () => reject(new DetectionError("execution_limit")),
        timeout,
      );
      worker.once("message", (output: unknown) => {
        if (
          typeof output !== "string" ||
          Buffer.byteLength(output) > 4 * 1024 * 1024
        )
          return reject(new DetectionError("execution_limit"));
        try {
          const value = JSON.parse(output);
          if (!value.ok) reject(new DetectionError(value.error));
          else resolveResult(value.result as T);
        } catch {
          reject(new DetectionError("execution_failed"));
        }
      });
      worker.once("error", () => reject(new DetectionError("execution_limit")));
      worker.once("exit", () => reject(new DetectionError("execution_failed")));
    });
  } finally {
    clearTimeout(timer);
    await worker?.terminate();
    active--;
  }
}
