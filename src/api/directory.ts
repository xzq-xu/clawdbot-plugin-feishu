/**
 * User and group directory operations.
 */

import type { Config } from "../config/schema.js";
import type { DirectoryUser, DirectoryGroup, ListDirectoryParams } from "../types/index.js";
import { getApiClient } from "./client.js";
import { resolveCredentials } from "../config/schema.js";
import { normalizeTarget } from "./messages.js";

// ============================================================================
// Static Directory (from config)
// ============================================================================

/**
 * List users from config allowlists.
 * Used as fallback when API access is unavailable.
 */
export function listUsersFromConfig(config: Config, params: ListDirectoryParams): DirectoryUser[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const ids = new Set<string>();

  // Collect from DM allowlist
  for (const entry of config.allowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") ids.add(trimmed);
  }

  // Collect from DM configs
  for (const userId of Object.keys(config.dms ?? {})) {
    const trimmed = userId.trim();
    if (trimmed) ids.add(trimmed);
  }

  return Array.from(ids)
    .map((raw) => normalizeTarget(raw) ?? raw)
    .filter((id) => !query || id.toLowerCase().includes(query))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "user" as const, id }));
}

/**
 * List groups from config allowlists.
 * Used as fallback when API access is unavailable.
 */
export function listGroupsFromConfig(
  config: Config,
  params: ListDirectoryParams
): DirectoryGroup[] {
  const query = params.query?.trim().toLowerCase() ?? "";
  const ids = new Set<string>();

  // Collect from group configs
  for (const groupId of Object.keys(config.groups ?? {})) {
    const trimmed = groupId.trim();
    if (trimmed && trimmed !== "*") ids.add(trimmed);
  }

  // Collect from group allowlist
  for (const entry of config.groupAllowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") ids.add(trimmed);
  }

  return Array.from(ids)
    .filter((id) => !query || id.toLowerCase().includes(query))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "group" as const, id }));
}

// ============================================================================
// Live Directory (from API)
// ============================================================================

/**
 * List users from Feishu API.
 * Falls back to config-based listing if API unavailable.
 */
export async function listUsers(
  config: Config,
  params: ListDirectoryParams
): Promise<DirectoryUser[]> {
  const credentials = resolveCredentials(config);
  if (!credentials) {
    return listUsersFromConfig(config, params);
  }

  try {
    const client = getApiClient(config);
    const limit = params.limit ?? 50;
    const query = params.query?.trim().toLowerCase() ?? "";

    const users: DirectoryUser[] = [];

    // Use SDK's iterator for automatic pagination
    const iterator = await client.contact.user.listWithIterator({
      params: { page_size: Math.min(limit, 50) },
    });

    for await (const page of iterator) {
      const items = page?.items;
      if (!items) continue;

      for (const user of items) {
        if (!user.open_id) continue;

        const name = user.name ?? "";
        const matchesQuery =
          !query ||
          user.open_id.toLowerCase().includes(query) ||
          name.toLowerCase().includes(query);

        if (matchesQuery) {
          users.push({
            kind: "user",
            id: user.open_id,
            name: name || undefined,
          });
        }

        if (users.length >= limit) break;
      }

      if (users.length >= limit) break;
    }

    return users;
  } catch {
    return listUsersFromConfig(config, params);
  }
}

/**
 * List groups from Feishu API.
 * Falls back to config-based listing if API unavailable.
 */
export async function listGroups(
  config: Config,
  params: ListDirectoryParams
): Promise<DirectoryGroup[]> {
  const credentials = resolveCredentials(config);
  if (!credentials) {
    return listGroupsFromConfig(config, params);
  }

  try {
    const client = getApiClient(config);
    const limit = params.limit ?? 50;
    const query = params.query?.trim().toLowerCase() ?? "";

    const groups: DirectoryGroup[] = [];

    // Use SDK's iterator for automatic pagination
    const iterator = await client.im.chat.listWithIterator({
      params: { page_size: Math.min(limit, 100) },
    });

    for await (const page of iterator) {
      const items = page?.items;
      if (!items) continue;

      for (const chat of items) {
        if (!chat.chat_id) continue;

        const name = chat.name ?? "";
        const matchesQuery =
          !query ||
          chat.chat_id.toLowerCase().includes(query) ||
          name.toLowerCase().includes(query);

        if (matchesQuery) {
          groups.push({
            kind: "group",
            id: chat.chat_id,
            name: name || undefined,
          });
        }

        if (groups.length >= limit) break;
      }

      if (groups.length >= limit) break;
    }

    return groups;
  } catch {
    return listGroupsFromConfig(config, params);
  }
}
