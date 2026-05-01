#!/usr/bin/env node
/**
 * Mattermost MCP Server
 * Запуск: npx github:anton-sobolev-zhr/mattermost-mcp
 * Или: node dist/index.js (с установленными env vars)
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const MATTERMOST_URL = process.env.MATTERMOST_URL;
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN || process.env.MATTERMOST_ACCESS_TOKEN;
const KEEPALIVE_INTERVAL_MS = Number.parseInt(
  process.env.MATTERMOST_KEEPALIVE_MS || `${24 * 60 * 60 * 1000}`,
  10,
);

if (!MATTERMOST_URL || !MATTERMOST_TOKEN) {
  console.error("Error: MATTERMOST_URL and MATTERMOST_TOKEN env vars required");
  process.exit(1);
}

const baseUrl = MATTERMOST_URL.replace(/\/$/, "");

type ApiResult = { status: number; data: any };

type User = {
  id: string;
  username?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
};

const userCache = new Map<string, User>();

async function apiRequest(path: string, init?: RequestInit): Promise<ApiResult> {
  const url = `${baseUrl}/api/v4${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Authorization": `Bearer ${MATTERMOST_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  return { status: response.status, data };
}

async function apiGet(path: string): Promise<ApiResult> {
  return apiRequest(path);
}

async function apiPost(path: string, body: any): Promise<ApiResult> {
  return apiRequest(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function getUser(userId: string): Promise<User | null> {
  if (userCache.has(userId)) {
    return userCache.get(userId)!;
  }

  const { status, data } = await apiGet(`/users/${userId}`);
  if (status !== 200) {
    return null;
  }

  userCache.set(userId, data);
  return data;
}

function formatDisplayName(user: User | null, fallbackId: string): string {
  if (!user) {
    return fallbackId;
  }

  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || user.username || user.nickname || fallbackId;
}

async function formatPostLines(order: string[], posts: Record<string, any>): Promise<string[]> {
  const lines: string[] = [];

  for (const pid of order) {
    const post = posts[pid] || {};
    const msg = (post.message || "").trim();
    if (!msg) {
      continue;
    }

    const userId = post.user_id || "?";
    const user = await getUser(userId);
    const author = formatDisplayName(user, userId);
    lines.push(`[${author}] ${msg}`);
  }

  return lines;
}

function startKeepalive(): void {
  if (!Number.isFinite(KEEPALIVE_INTERVAL_MS) || KEEPALIVE_INTERVAL_MS <= 0) {
    return;
  }

  const timer = setInterval(async () => {
    try {
      const { status, data } = await apiGet("/users/me");
      if (status === 200) {
        console.error(`[mattermost-mcp] keepalive ok for ${data.username || data.id}`);
      } else {
        console.error(`[mattermost-mcp] keepalive failed: HTTP ${status}`);
      }
    } catch (error) {
      console.error(`[mattermost-mcp] keepalive error: ${error}`);
    }
  }, KEEPALIVE_INTERVAL_MS);

  timer.unref?.();
}

const server = new Server(
  {
    name: "mattermost-mcp",
    version: "1.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_thread",
        description: "Get Mattermost thread content by post ID",
        inputSchema: {
          type: "object",
          properties: {
            post_id: {
              type: "string",
              description: "Post ID (26 alphanumeric characters)",
            },
          },
          required: ["post_id"],
        },
      },
      {
        name: "get_post",
        description: "Get single post content by ID",
        inputSchema: {
          type: "object",
          properties: {
            post_id: {
              type: "string",
              description: "Post ID",
            },
          },
          required: ["post_id"],
        },
      },
      {
        name: "get_channel_posts",
        description: "Get posts from a channel",
        inputSchema: {
          type: "object",
          properties: {
            channel_id: {
              type: "string",
              description: "Channel ID",
            },
            limit: {
              type: "number",
              description: "Number of posts (default 60)",
              default: 60,
            },
          },
          required: ["channel_id"],
        },
      },
      {
        name: "search_posts",
        description: "Search posts in team",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query",
            },
            team_id: {
              type: "string",
              description: "Team ID (optional)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "list_channels",
        description: "List channels in team",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Team ID",
            },
          },
          required: [],
        },
      },
      {
        name: "get_user",
        description: "Get user info by ID",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "string",
              description: "User ID",
            },
          },
          required: ["user_id"],
        },
      },
      {
        name: "send_message",
        description: "Send message to channel",
        inputSchema: {
          type: "object",
          properties: {
            channel_id: {
              type: "string",
              description: "Channel ID",
            },
            message: {
              type: "string",
              description: "Message text",
            },
          },
          required: ["channel_id", "message"],
        },
      },
      {
        name: "test_connection",
        description: "Test Mattermost connection",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_unread",
        description: "Get unread messages, threads and channels summary",
        inputSchema: {
          type: "object",
          properties: {
            team_id: {
              type: "string",
              description: "Team ID (optional, defaults to first team)",
            },
            include_threads: {
              type: "boolean",
              description: "Include collapsed reply threads (default: true)",
              default: true,
            },
            include_channels: {
              type: "boolean",
              description: "Include channel unread summary (default: true)",
              default: true,
            },
            limit: {
              type: "number",
              description: "Max channels/threads to show (default: 20)",
              default: 20,
            },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "get_thread": {
        const postId = z.string().parse(args?.post_id);
        const { status, data } = await apiGet(`/posts/${postId}/thread`);

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        const posts = data.posts || {};
        const order = data.order || [postId];
        const lines = await formatPostLines(order, posts);

        return {
          content: [{ type: "text", text: lines.join("\n") || "No messages" }],
        };
      }

      case "get_post": {
        const postId = z.string().parse(args?.post_id);
        const { status, data } = await apiGet(`/posts/${postId}`);

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        const user = await getUser(data.user_id || "");
        const author = formatDisplayName(user, data.user_id || "?");
        return {
          content: [{ type: "text", text: `[${author}] ${data.message || "Empty post"}` }],
        };
      }

      case "get_channel_posts": {
        const channelId = z.string().parse(args?.channel_id);
        const limit = z.number().default(60).parse(args?.limit);
        const { status, data } = await apiGet(`/channels/${channelId}/posts?per_page=${limit}`);

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        const posts = data.posts || {};
        const order = data.order || [];
        const lines = await formatPostLines(order.slice(0, limit), posts);

        return {
          content: [{ type: "text", text: lines.join("\n") || "No messages" }],
        };
      }

      case "search_posts": {
        const query = z.string().parse(args?.query);
        const teamId = z.string().optional().parse(args?.team_id);

        let searchTeamId = teamId;
        if (!searchTeamId) {
          const { data: teams } = await apiGet("/users/me/teams");
          if (teams && teams.length > 0) {
            searchTeamId = teams[0].id;
          }
        }

        if (!searchTeamId) {
          return {
            content: [{ type: "text", text: "Error: No team_id provided or found" }],
          };
        }

        const { status, data } = await apiPost(`/teams/${searchTeamId}/posts/search`, {
          terms: query,
          is_or_search: false,
        });

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        const posts = data.posts || {};
        const order = data.order || [];
        const lines: string[] = [];

        for (const pid of order.slice(0, 10)) {
          const post = posts[pid] || {};
          const msg = (post.message || "").trim();
          if (!msg) {
            continue;
          }
          const user = await getUser(post.user_id || "");
          const author = formatDisplayName(user, post.user_id || "?");
          lines.push(`[${author}] ${msg.substring(0, 200)}${msg.length > 200 ? "..." : ""}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") || "No results" }],
        };
      }

      case "list_channels": {
        const { data: teams } = await apiGet("/users/me/teams");

        if (!teams || teams.length === 0) {
          return { content: [{ type: "text", text: "No teams found" }] };
        }

        const teamId = args?.team_id || teams[0].id;
        const { status, data } = await apiGet(`/users/me/teams/${teamId}/channels`);

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        const channels = data || [];
        const lines = channels.map((ch: any) => `${ch.name} (${ch.id}) - ${ch.display_name}`);
        return { content: [{ type: "text", text: lines.join("\n") || "No channels" }] };
      }

      case "get_user": {
        const userId = z.string().parse(args?.user_id);
        const { status, data } = await apiGet(`/users/${userId}`);

        if (status !== 200) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "send_message": {
        const channelId = z.string().parse(args?.channel_id);
        const message = z.string().parse(args?.message);
        const { status, data } = await apiPost("/posts", { channel_id: channelId, message });

        if (status !== 201) {
          return { content: [{ type: "text", text: `Error: HTTP ${status}` }] };
        }

        return { content: [{ type: "text", text: `Message sent: ${data.id}` }] };
      }

      case "test_connection": {
        const { status, data } = await apiGet("/users/me");
        if (status === 200) {
          return {
            content: [{ type: "text", text: `Connected as: ${data.username} (${data.email})` }],
          };
        }
        return { content: [{ type: "text", text: `Connection failed: HTTP ${status}` }] };
      }

      case "get_unread": {
        const teamIdOpt = z.string().optional().parse(args?.team_id);
        const includeThreads = z.boolean().default(true).parse(args?.include_threads ?? true);
        const includeChannels = z.boolean().default(true).parse(args?.include_channels ?? true);
        const limit = z.number().default(20).parse(args?.limit ?? 20);

        const { status: uStatus, data: me } = await apiGet("/users/me");
        if (uStatus !== 200) {
          return { content: [{ type: "text", text: `Error loading current user: HTTP ${uStatus}` }] };
        }
        const myId = me.id;

        const { status: teamsStatus, data: teams } = await apiGet("/users/me/teams");
        if (teamsStatus !== 200) {
          return { content: [{ type: "text", text: `Error loading teams: HTTP ${teamsStatus}` }] };
        }
        if (!teams || teams.length === 0) {
          return { content: [{ type: "text", text: "No teams found" }] };
        }

        const { status: unreadStatus, data: unreadTeams } = await apiGet("/users/me/teams/unread");
        if (unreadStatus !== 200) {
          return {
            content: [{ type: "text", text: `Error loading unread team summary: HTTP ${unreadStatus}` }],
          };
        }
        const unreadTeamsMap = new Map<string, any>(
          Array.isArray(unreadTeams) ? unreadTeams.map((item: any) => [item.team_id, item]) : []
        );

        const targetTeams = teamIdOpt
          ? teams.filter((t: any) => t.id === teamIdOpt)
          : teams;
        if (teamIdOpt && targetTeams.length === 0) {
          return { content: [{ type: "text", text: `Team not found: ${teamIdOpt}` }] };
        }

        const parts: string[] = [];

        for (const team of targetTeams) {
          const teamLines: string[] = [];
          const teamName = team.display_name || team.name;
          const teamUnread = unreadTeamsMap.get(team.id);

          if (includeChannels) {
            const { status: chStatus, data: channels } = await apiGet(
              `/users/me/teams/${team.id}/channels`
            );

            if (chStatus !== 200) {
              teamLines.push(`Channels: Error HTTP ${chStatus}`);
            } else {
              const { status: membersStatus, data: members } = await apiGet(
                `/users/${myId}/teams/${team.id}/channels/members`
              );
              if (membersStatus !== 200) {
                teamLines.push(`Channel members: Error HTTP ${membersStatus}`);
              } else {
                const membersMap = new Map<string, any>();
                if (Array.isArray(members)) {
                  for (const m of members) {
                    membersMap.set(m.channel_id, m);
                  }
                }

                const unreadChannels: string[] = [];
                let totalUnread = 0;
                let totalUnreadRoot = 0;
                let totalMentions = 0;

                for (const ch of channels) {
                  const mem = membersMap.get(ch.id);
                  const unread = Math.max(
                    0,
                    (ch.total_msg_count || 0) - (mem?.msg_count || 0)
                  );
                  const unreadRoot = Math.max(
                    0,
                    (ch.total_msg_count_root || 0) - (mem?.msg_count_root || 0)
                  );
                  const mentions = (mem?.mention_count || 0) + (mem?.mention_count_root || 0);

                  if (unread > 0 || unreadRoot > 0 || mentions > 0) {
                    totalUnread += unread;
                    totalUnreadRoot += unreadRoot;
                    totalMentions += mentions;
                    const typeTag: Record<string, string> = { O: "#", D: "@", G: "@", P: "@" };
                    const tag = typeTag[ch.type] || "";
                    const unreadInfo = [];
                    if (unread > 0) unreadInfo.push(`${unread} unread`);
                    if (unreadRoot > 0) unreadInfo.push(`${unreadRoot} root`);
                    if (mentions > 0) unreadInfo.push(`${mentions} mentions`);
                    unreadChannels.push(
                      `${tag}${ch.display_name} (${ch.name}) — ${unreadInfo.join(", ")}`
                    );
                  }
                }

                if (unreadChannels.length > 0) {
                  const summaryBits = [
                    `${teamUnread?.msg_count ?? totalUnread} unread`,
                    `${teamUnread?.mention_count ?? totalMentions} mentions`,
                  ];
                  if (totalUnreadRoot > 0) {
                    summaryBits.push(`${totalUnreadRoot} root`);
                  }
                  teamLines.push(`Team "${teamName}" (${team.id}): ${summaryBits.join(", ")}`);
                  teamLines.push(...unreadChannels.slice(0, limit));
                  if (unreadChannels.length > limit) {
                    teamLines.push(`  ... and ${unreadChannels.length - limit} more channels`);
                  }
                } else {
                  teamLines.push(`Team "${teamName}": no unread`);
                }
              }
            }
          }

          if (includeThreads) {
            const { status: tStatus, data: threadData } = await apiGet(
              `/users/me/teams/${team.id}/threads?unread=true&per_page=${limit}`
            );

            if (tStatus !== 200) {
              teamLines.push(`Threads: Error HTTP ${tStatus}`);
            } else {
              const total = threadData.total || 0;
              const totalUnreadThreads = threadData.total_unread_threads || 0;
              teamLines.push(`Threads in "${teamName}": ${totalUnreadThreads} unread of ${total} total`);

              const threads = threadData.threads || [];
              for (const thr of threads) {
                const preview = (thr.post?.message || "").substring(0, 80);
                const unreadReplies = thr.unread_replies || 0;
                const unreadMentions = thr.unread_mentions || 0;
                const info = [];
                if (unreadReplies > 0) info.push(`${unreadReplies} replies`);
                if (unreadMentions > 0) info.push(`${unreadMentions} mentions`);
                teamLines.push(
                  `  Thread ${thr.id}: ${preview || "(no preview)"}${info.length > 0 ? ` [${info.join(", ")}]` : ""}`
                );
              }
            }
          }

          if (parts.length > 0 && teamLines.length > 0) {
            parts.push("");
          }
          parts.push(...teamLines);
        }

        return {
          content: [{ type: "text", text: parts.join("\n") || "No unread" }],
        };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error}` }] };
  }
});

async function main() {
  startKeepalive();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
