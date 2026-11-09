import { and, eq, inArray } from "drizzle-orm";
import { chatActions, chatConversations, chatDeliveries, chatEndpointResources, chatMessageLinks, issueComments, toolConnections } from "@paperclipai/db";
import { forbidden } from "../../../errors.js";
import type { DbOrTransaction, EndpointRow, LifecycleRuntimeFence } from "../runtime-types.js";
import { credentialFingerprint } from "../credential-fingerprint.js";
import { readTaskChatRetryIntent } from "../task-retry-authority.js";

export type TaskRetryWakeAuthority = {
  intentId: string;
  sourceRunId: string;
  runtimeFence?: LifecycleRuntimeFence;
};

export function githubTaskRetryAppMatches(endpoint: EndpointRow, delivery: typeof chatDeliveries.$inferSelect,
  response: { payload: Record<string, unknown> } | undefined) {
  const original = delivery.normalizedEvent.githubAuthority as { botExternalId?: unknown } | undefined;
  return original?.botExternalId !== undefined ? original.botExternalId === endpoint.botExternalId
    : response?.payload.botExternalId === endpoint.botExternalId && response.payload.agentId === endpoint.assignedAgentId;
}

export function githubTaskRetryDestinationMatches(delivery: typeof chatDeliveries.$inferSelect,
  conversation: typeof chatConversations.$inferSelect, resource: typeof chatEndpointResources.$inferSelect | null) {
  const originalResource = delivery.normalizedEvent.resource as { providerResourceId?: unknown } | undefined;
  const originalThread = delivery.normalizedEvent.conversation as { externalThreadId?: unknown } | undefined;
  const automatic = (delivery.normalizedEvent.githubAutomatic ?? delivery.normalizedEvent.githubIssue) as
    { context?: { repositoryId?: unknown } } | undefined;
  return resource && originalResource?.providerResourceId === resource.providerResourceId
    && originalThread?.externalThreadId === conversation.externalThreadId
    && (automatic?.context?.repositoryId === undefined
      || automatic.context.repositoryId === resource.metadata.providerRepositoryId);
}

export async function githubTaskRetryRuntimeFence(tx: DbOrTransaction, endpoint: EndpointRow,
  action: typeof chatActions.$inferSelect, delivery: typeof chatDeliveries.$inferSelect,
  authority: TaskRetryWakeAuthority): Promise<LifecycleRuntimeFence> {
  const deny = () => forbidden("This accepted chat message is no longer authorized to start work",
    { code: "chat_action_authorization_changed" });
  const retry = await readTaskChatRetryIntent(tx as Parameters<typeof readTaskChatRetryIntent>[0], {
    companyId: action.companyId, issueId: String(action.payload.issueId),
    agentId: String(action.payload.agentId), sourceRunId: authority.sourceRunId, intentId: authority.intentId,
  });
  if (!retry || endpoint.provider !== "github" || !endpoint.botExternalId || action.kind !== "inbound_wakeup"
    || action.status !== "processed" || delivery.state !== "processed") throw deny();
  const [response] = await tx.select({ payload: chatActions.payload }).from(chatActions).where(and(
    eq(chatActions.companyId, action.companyId), eq(chatActions.endpointId, endpoint.id),
    eq(chatActions.conversationId, action.conversationId!), eq(chatActions.deliveryId, delivery.id),
    eq(chatActions.kind, "github_response_comment"),
  ));
  if (!githubTaskRetryAppMatches(endpoint, delivery, response)) throw deny();
  const [connection] = await tx.select({ refs: toolConnections.credentialSecretRefs,
    enabled: toolConnections.enabled, status: toolConnections.status }).from(toolConnections).where(and(
    eq(toolConnections.companyId, endpoint.companyId), eq(toolConnections.id, endpoint.connectionId),
  ));
  if (!connection?.enabled || connection.status !== "active") throw deny();
  const generation = Number((endpoint.setup as { runtimeGeneration?: unknown }).runtimeGeneration ?? 0);
  if (!Number.isSafeInteger(generation) || generation < 0) throw deny();
  return authority.runtimeFence ?? { generation, credentialFingerprint: credentialFingerprint(connection.refs ?? []) };
}

type GitHubRetryBinding = {
  endpoint: EndpointRow;
  conversation: typeof chatConversations.$inferSelect;
  resource: typeof chatEndpointResources.$inferSelect | null;
  delivery: typeof chatDeliveries.$inferSelect;
  retryRuntimeFence?: LifecycleRuntimeFence;
};

export function createGitHubTaskRetryBatchAuthority<T extends GitHubRetryBinding>(authorize: (
  tx: DbOrTransaction, action: typeof chatActions.$inferSelect,
  notice: { nonblocking: true; terminal: boolean; taskRetry: TaskRetryWakeAuthority },
) => Promise<T>) {
  async function authorizeGitHubTaskRetryBatch(tx: DbOrTransaction, actions: Array<typeof chatActions.$inferSelect>,
    notice: { nonblocking: true; terminal: boolean; taskRetry: TaskRetryWakeAuthority }) {
    const deny = () => forbidden("This accepted chat message is no longer authorized to start work",
      { code: "chat_action_authorization_changed" });
    const first = actions[0];
    if (!first) throw deny();
    const commonScope = (action: typeof chatActions.$inferSelect) => JSON.stringify([
      action.companyId, action.endpointId, action.conversationId, action.principalId, action.kind, action.status,
      ...["version", "issueId", "agentId", "sessionGeneration", "requestedByActorType", "requestedByActorId"]
        .map(key => action.payload[key]),
    ]);
    if (actions.some(action => commonScope(action) !== commonScope(first))) throw deny();
    const deliveries = await tx.select().from(chatDeliveries).where(and(eq(chatDeliveries.companyId, first.companyId),
      inArray(chatDeliveries.id, actions.map(action => action.deliveryId!))));
    const byDelivery = new Map(deliveries.map(delivery => [delivery.id, delivery]));
    const legacy = await tx.select().from(chatActions).where(and(eq(chatActions.companyId, first.companyId),
      eq(chatActions.endpointId, first.endpointId), eq(chatActions.conversationId, first.conversationId!),
      eq(chatActions.kind, "github_response_comment"), inArray(chatActions.deliveryId, deliveries.map(delivery => delivery.id))));
    const legacyByDelivery = new Map(legacy.map(action => [action.deliveryId, action]));
    const links = await tx.select({ deliveryId: chatMessageLinks.deliveryId, commentId: chatMessageLinks.commentId,
      authorUserId: issueComments.authorUserId, deletedAt: issueComments.deletedAt }).from(chatMessageLinks)
      .innerJoin(issueComments, and(eq(issueComments.id, chatMessageLinks.commentId),
        eq(issueComments.companyId, first.companyId), eq(issueComments.issueId, String(first.payload.issueId))))
      .where(and(eq(chatMessageLinks.companyId, first.companyId), eq(chatMessageLinks.endpointId, first.endpointId),
        eq(chatMessageLinks.conversationId, first.conversationId!), eq(chatMessageLinks.direction, "inbound"),
        inArray(chatMessageLinks.deliveryId, deliveries.map(delivery => delivery.id))));
    const expectedUserId = first.payload.requestedByActorType === "user" ? first.payload.requestedByActorId : null;
    const linked = new Set(links.filter(link => (!link.deletedAt || notice.terminal) && link.authorUserId === expectedUserId)
      .map(link => `${link.deliveryId}:${link.commentId}`));
    const groups = new Map<string, T>();
    const authorized = new Map<string, T>();
    for (const action of actions) {
      const delivery = byDelivery.get(action.deliveryId!);
      if (!delivery || !linked.has(`${delivery.id}:${action.payload.commentId}`)) throw deny();
      // Reuse only the same live grant within this transaction. Automatic review
      // policies with different contexts still receive their own full check.
      const grant = JSON.stringify(delivery.normalizedEvent.githubAutomatic ?? delivery.normalizedEvent.githubIssue ?? null);
      let current = groups.get(grant);
      if (!current) {
        current = await authorize(tx, action, notice);
        if (current.endpoint.provider !== "github") throw deny();
        notice.taskRetry.runtimeFence ??= current.retryRuntimeFence;
        groups.set(grant, current);
      }
      if (delivery.state !== "processed" || delivery.endpointId !== current.endpoint.id ||
          delivery.conversationId !== current.conversation.id || delivery.principalId !== action.principalId ||
          !githubTaskRetryAppMatches(current.endpoint, delivery, legacyByDelivery.get(delivery.id)) ||
          !githubTaskRetryDestinationMatches(delivery, current.conversation, current.resource)) throw deny();
      authorized.set(action.id, { ...current, delivery });
    }
    return authorized;
  }

  return authorizeGitHubTaskRetryBatch;
}
