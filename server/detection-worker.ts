import { parentPort, workerData } from "node:worker_threads";
import { run } from "./worker";
parentPort!.postMessage(run(workerData));
