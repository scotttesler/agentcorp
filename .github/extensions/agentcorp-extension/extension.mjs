import { setTimeout as sleep } from "node:timers/promises";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { createPublisher } from "./presence.mjs";
import { shouldRegister } from "./provider-selection.mjs";
import { startServer } from "./viewer-server.mjs";

const servers = new Map();
const active = await shouldRegister(import.meta.url);
const publisher = active ? createPublisher({ sessionId: process.env.SESSION_ID }) : null;
if (publisher) {
  process.on("exit", () => publisher.stop());
  const quit = () => Promise.race([publisher.stop(), sleep(1000)]).then(() => process.exit(0));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, quit);
}

const session = await joinSession({
  ...(publisher && { onEvent: event => publisher.onEvent(event) }),
  canvases: active ? [createCanvas({
    id: "agentcorp-observer",
    displayName: "AgentCorp · Live sessions",
    description: "Read-only 3D office of your top-level Copilot sessions on this computer, showing who needs you, who is working and who is idle.",
    open: async ({ instanceId, sessionId }) => {
      let entry = servers.get(instanceId);
      if (!entry) {
        entry = await startServer(sessionId);
        servers.set(instanceId, entry);
      }
      return { title: "AgentCorp · Live sessions", url: entry.url };
    },
    onClose: async ({ instanceId }) => {
      const entry = servers.get(instanceId);
      if (entry) {
        servers.delete(instanceId);
        await new Promise((done, reject) => entry.server.close(error => error ? reject(error) : done()));
      }
    },
  })] : [],
});

if (!active) console.error("AgentCorp observer inactive: another user-scope observer owns this canvas.");
if (publisher) void publisher.start({ workspacePath: session.workspacePath, metadata: session.rpc.metadata });
