# s1s-mcp

A MCP server for system one search.

## Supported system one model providers
- OpenRouter
- TypeSafe AI
- OpenAI (comming soon...)


## binary
```sh
curl -fsSL https://github.com/Levack/s1s-mcp/releases/latest/download/install.sh | sh
```

## npx

Requires Node.js 24 or newer. 
```sh
# Choose a provider and authentication method interactively.
npx --yes @levack/s1s-mcp@latest login

# Specify OpenRouter with browser authorization or api-key.
npx --yes @levack/s1s-mcp@latest login --provider openrouter --auth-method oauth
npx --yes @levack/s1s-mcp@latest login --provider openrouter --auth-method api-key

# Specify TypeSafe with api-key.
npx --yes @levack/s1s-mcp@latest login --provider typesafe
```

Start the MCP server:
```sh
npx --yes @levack/s1s-mcp@latest
```


## For coding CLIs

### Claude Code

```sh
claude mcp add --scope local --transport stdio s1s -- \
  npx --yes @levack/s1s-mcp@latest
```

### Codex CLI
```sh
codex mcp add s1s -- \
  npx --yes @levack/s1s-mcp@latest
```

### OpenCode

```sh
opencode mcp add s1s -- \
  npx --yes @levack/s1s-mcp@latest
```

Check the connection with `opencode mcp list`. See the [OpenCode MCP docs](https://opencode.ai/v2/docs/mcp-servers).

### .mcp.json
```json
{
  "mcpServers": {
    "s1s": {
      "command": "npx",
      "args": [
        "--yes", "@levack/s1s-mcp@latest"
      ]
    }
  }
}
```

## Other commands

```sh
# Print effective configuration without secrets.
npx --yes @levack/s1s-mcp@latest config

# Remove saved credentials for a provider.
npx --yes @levack/s1s-mcp@latest logout --provider openrouter
npx --yes @levack/s1s-mcp@latest logout --provider typesafe


# Show available options and the installed version.
npx --yes @levack/s1s-mcp@latest --help
npx --yes @levack/s1s-mcp@latest --version
```
