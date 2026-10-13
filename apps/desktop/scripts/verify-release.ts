import { fileURLToPath } from "node:url";
import { verifyReleaseArtifacts } from "./release-artifacts.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
console.log(JSON.stringify(await verifyReleaseArtifacts(repo), null, 2));
