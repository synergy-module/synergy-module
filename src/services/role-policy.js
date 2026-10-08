import { CAPABILITIES, ROLES } from "../models/access.js";

const KNOWN_ROLES = new Set(Object.values(ROLES));

function normalizeRoleNames(names) {
  const normalized = [];
  for (const name of names ?? []) {
    const role = typeof name === "string" ? name.trim() : "";
    if (KNOWN_ROLES.has(role) && !normalized.includes(role)) {
      normalized.push(role);
    }
  }
  return normalized;
}

function capabilitiesFor(roles) {
  const isPrivileged = roles.includes(ROLES.DEVELOPER) || roles.includes(ROLES.ADMIN);
  const capabilities = new Set();

  if (isPrivileged || roles.includes(ROLES.OS)) capabilities.add(CAPABILITIES.BASE);
  if (isPrivileged || roles.includes(ROLES.INDICATORS)) capabilities.add(CAPABILITIES.INDICATORS);
  if (isPrivileged || roles.includes(ROLES.JOURNAL)) capabilities.add(CAPABILITIES.JOURNAL);
  if (isPrivileged) capabilities.add(CAPABILITIES.ADMIN);

  return [...capabilities];
}

function operatorFromRoleNames(names) {
  const roles = normalizeRoleNames(names);
  return { roles, capabilities: capabilitiesFor(roles) };
}

export function createRolePolicy({ roleIds }) {
  const configuredRolesById = new Map(
    Object.values(ROLES)
      .filter((role) => typeof roleIds?.[role] === "string")
      .map((role) => [roleIds[role], role]),
  );

  return {
    fromDiscordRoleIds(ids) {
      return operatorFromRoleNames(
        [...new Set(ids ?? [])]
          .map((id) => configuredRolesById.get(id))
          .filter(Boolean),
      );
    },
    fromRoleNames(names) {
      return operatorFromRoleNames(names);
    },
    can(operator, capability) {
      return operator?.capabilities?.includes(capability) ?? false;
    },
    hasBaseAccess(operator) {
      return operator?.capabilities?.includes(CAPABILITIES.BASE) ?? false;
    },
  };
}
