import type { KeeperHubConfig } from "../types/index.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import { createDaydreamsActions } from "./actions.js";

export interface DreamKeeperExtension {
  name: string;
  client: KeeperHubClient;
  actions: Array<{
    name: string;
    description: string;
    schema: any;
    handler: (params: any, ctx?: any) => Promise<any>;
  }> & ReturnType<typeof createDaydreamsActions>;
  actionsMap: ReturnType<typeof createDaydreamsActions>;
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
  const actionsMap = createDaydreamsActions(client);

  const actionsList = [
    actionsMap.dryRunAction,
    actionsMap.executeAction,
    actionsMap.reconcileAction,
    actionsMap.auditAction,
  ];

  // Make actions an array for Daydreams, while preserving named access for tests
  const actions = Object.assign(actionsList, actionsMap);

  return {
    name: "dreamkeeper",
    client,
    actions,
    actionsMap,
    actionsList,
  };
}

// Alias for seamless discovery
export const keeperhubExtension = dreamkeeperExtension;
