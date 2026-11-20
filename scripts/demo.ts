/**
 * A demo Reelix for trying the web UI: the fake services of packages/server/src/demo.ts, the real agent
 * through pi, and downloads that "finish" after ~30 s. Media go beside the data folder.
 *
 *   REELIX_DATA=/tmp/reelix-demo REELIX_PI_DIR=~/.pi/agent REELIX_DEMO_PASSWORD=… \
 *     REELIX_DEMO_MODEL=provider/model node --no-warnings --disable-sigusr1 scripts/demo.ts
 */
import { startDemo } from "../packages/server/src/demo.ts";
import { startServer } from "../packages/server/src/main.ts";

const root = process.env.REELIX_DATA ?? "/tmp/reelix-demo";
console.log(await startDemo(root, { password: process.env.REELIX_DEMO_PASSWORD, model: process.env.REELIX_DEMO_MODEL }));
process.env.REELIX_DATA = root;
await startServer();
