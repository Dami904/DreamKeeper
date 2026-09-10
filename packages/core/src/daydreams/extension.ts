import type { KeeperHubConfig } from "../types/index.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import { createDaydreamsActions } from "./actions.js";

export interface DreamKeeperExtension {
  name: string;
  client: KeeperHubClient;
  actions: ReturnType<typeof createDaydreamsActions>;
  actionsList: Array<{
    name: string;
    description: string;
    schema: any;
    handler: (params: any, ctx?: any) => Promise<any>;
  }>;
}

/**
 * Creates a native Daydreams Extension integrating KeeperHub deterministic execution
 * and the DreamKeeper Hallucination Firewall.
 */
export function dreamkeeperExtension(
  config: KeeperHubConfig,
): DreamKeeperExtension {
  const client = new KeeperHubClient(config);
  const actions = createDaydreamsActions(client);

  return {
    name: "dreamkeeper",
    client,
    actions,
    actionsList: [
      actions.dryRunAction,
      actions.executeAction,
      actions.reconcileAction,
      actions.auditAction,
    ],
  };
}

// Alias for seamless discovery
export const keeperhubExtension = dreamkeeperExtension;
