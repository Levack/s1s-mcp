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

## MCP tools

- `rank_candidates`: filter and rank candidate contents for a search purpose.
- `noul`: evaluate yes/no probabilities.
- `score`: evaluate ordered rubrics.
- `choice`: classify context into named categories.

Read files or fetch pages with your coding CLI, then pass their contents to MCP.

## Other commands

Prepare requests using the [Noul](examples/noul.json), [Score](examples/score.json), and [Choice](examples/choice.json) examples.

```sh
# Print effective configuration without secrets.
npx --yes @levack/s1s-mcp@latest config

# Remove saved credentials for a provider.
npx --yes @levack/s1s-mcp@latest logout --provider openrouter
npx --yes @levack/s1s-mcp@latest logout --provider typesafe

# Evaluate injected contents from a JSON request file or stdin.
npx --yes @levack/s1s-mcp@latest noul noul.json
npx --yes @levack/s1s-mcp@latest score score.json
npx --yes @levack/s1s-mcp@latest choice choice.json
cat request.json | npx --yes @levack/s1s-mcp@latest noul

# Show available options and the installed version.
npx --yes @levack/s1s-mcp@latest --help
npx --yes @levack/s1s-mcp@latest --version
```
