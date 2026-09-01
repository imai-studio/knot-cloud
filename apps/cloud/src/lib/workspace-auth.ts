import { createHmac } from "node:crypto";

import { getAuthorizedSession } from "@/lib/auth";
import { NeonWorkspaceRepository } from "@/lib/adapters/neon-workspaces";
import { getCloudEnvironment } from "@/lib/env";

export interface WorkspaceRecord {
  userId: string;
  tenantId: string;
  name: string;
  role: "owner" | "admin" | "member";
  suspended: boolean;
}

export interface WorkspaceRepository {
  resolveOrBootstrap(input: {
    authSessionId: string;
    authUserId: string;
    emailDigest: string;
    emailDigestVersion: number;
    defaultWorkspaceName: string;
  }): Promise<WorkspaceRecord | undefined>;
  selectForSession(input: {
    authSessionId: string;
    authUserId: string;
    tenantId: string;
  }): Promise<WorkspaceRecord | undefined>;
}

export interface HumanSessionIdentity {
  session: { id: string };
  user: { id: string; email: string; name: string };
}

export interface AuthorizedWorkspace {
  identity: HumanSessionIdentity;
  workspace: WorkspaceRecord;
}

const defaultWorkspaceName = "Personal workspace";
let repository: WorkspaceRepository | undefined;

export async function getAuthorizedWorkspace(
  requestHeaders: Headers,
): Promise<AuthorizedWorkspace | null> {
  const identity = await getAuthorizedSession(requestHeaders);
  if (!identity) return null;
  return resolveWorkspaceForIdentity(identity, getWorkspaceRepository());
}

export async function selectAuthorizedWorkspace(
  requestHeaders: Headers,
  tenantId: string,
): Promise<AuthorizedWorkspace | null> {
  const identity = await getAuthorizedSession(requestHeaders);
  if (!identity) return null;
  const workspace = await getWorkspaceRepository().selectForSession({
    authSessionId: identity.session.id,
    authUserId: identity.user.id,
    tenantId,
  });
  if (!workspace || workspace.suspended) return null;
  return { identity, workspace };
}

export async function resolveWorkspaceForIdentity(
  identity: HumanSessionIdentity,
  workspaceRepository: WorkspaceRepository,
  digestConfiguration?: { pepper: string; version: number },
): Promise<AuthorizedWorkspace | null> {
  const digest = digestConfiguration ?? identityDigestConfiguration();
  const workspace = await workspaceRepository.resolveOrBootstrap({
    authSessionId: identity.session.id,
    authUserId: identity.user.id,
    emailDigest: digestEmail(identity.user.email, digest.pepper),
    emailDigestVersion: digest.version,
    defaultWorkspaceName,
  });
  if (!workspace || workspace.suspended) return null;
  return { identity, workspace };
}

export function digestEmail(email: string, pepper: string): string {
  if (pepper.length < 32) {
    throw new TypeError("Identity digest pepper must contain 32 characters");
  }
  return createHmac("sha256", pepper)
    .update(email.trim().toLowerCase(), "utf8")
    .digest("hex");
}

function identityDigestConfiguration() {
  const environment = getCloudEnvironment();
  return {
    pepper: environment.IDENTITY_DIGEST_PEPPER,
    version: environment.IDENTITY_DIGEST_VERSION,
  };
}

function getWorkspaceRepository(): WorkspaceRepository {
  repository ??= new NeonWorkspaceRepository();
  return repository;
}
