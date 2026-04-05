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
