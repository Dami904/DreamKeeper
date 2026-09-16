import type { KeeperHubConfig } from "../types/index.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import { createDaydreamsActions } from "./actions.js";

export interface DreamKeeperExtension {
  name: string;
  // Daydreams' real Extension type requires `inputs` (unlike actions/outputs/
  // services/events, which are optional) — without it, createDreams() drops
  // this extension's contribution entirely instead of erroring, so its
  // actions never reach the agent's registry.
  inputs: Record<string, never>;
  client: KeeperHubClient;
  actions: Array<{
    name: string;
    description: string;
    schema: any;
    handler: (params: any, ctx?: any) => Promise<any>;
  }> &
    ReturnType<typeof createDaydreamsActions>;
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
    actionsMap.checkAndExecuteDryRunAction,
    actionsMap.checkAndExecuteAction,
    actionsMap.protocolActionAction,
    actionsMap.getSpendingLimitsAction,
    actionsMap.getTrustSummaryAction,
    actionsMap.tempoSignAndHoldAction,
    actionsMap.tempoReleaseHoldAction,
    actionsMap.tempoCancelHoldAction,
  ];

  // Make actions an array for Daydreams, while preserving named access for tests
  const actions = Object.assign(actionsList, actionsMap);

  return {
    name: "dreamkeeper",
    inputs: {},
    client,
    actions,
    actionsMap,
    actionsList,
  };
}

// Alias for seamless discovery
export const keeperhubExtension = dreamkeeperExtension;
