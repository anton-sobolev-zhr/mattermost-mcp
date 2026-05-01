# Mattermost MCP Server

MCP server for Mattermost with `npx` support.

## Installation and Usage

### Via npx

```bash
MATTERMOST_URL=https://mattermost.company.com \
MATTERMOST_TOKEN=your-token \
npx github:anton-sobolev-zhr/mattermost-mcp
```

### MCPHub Configuration

```json
{
  "mcpServers": {
    "mattermost": {
      "command": "npx",
      "args": ["github:anton-sobolev-zhr/mattermost-mcp"],
      "env": {
        "MATTERMOST_URL": "https://mattermost.company.com",
        "MATTERMOST_TOKEN": "your-token",
        "MATTERMOST_KEEPALIVE_MS": "86400000"
      }
    }
  }
}
```

`MATTERMOST_KEEPALIVE_MS` defaults to 24 hours. The server makes `GET /api/v4/users/me` requests to keep the session alive in configurations with `ExtendSessionLengthWithActivity`.

## Available Tools

- `get_thread` — get thread content by post ID
- `get_post` — get single post by ID
- `get_channel_posts` — get channel messages
- `search_posts` — search messages
- `list_channels` — list channels in team
- `get_user` — get user info by ID
- `send_message` — send message to channel
- `get_unread` — get unread messages, threads, and channel summary
- `test_connection` — test Mattermost connection
