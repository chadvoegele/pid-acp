# MCP OAuth with Pi

Use Pi CLI **1.5.2** to sign in as the pid-acp service user. pid-acp does not open a browser, run Pi, or use ACP caller credentials. All authorized conversations using a configured server share its service grant; their MCP sessions and workspace roots remain separate.

## Headless setup

1. Register a **public** client (no secret) with the authorization server. Configure its loopback redirect URI, e.g. `http://127.0.0.1:8765/callback`, and request a renewable grant. The following is an example for a server that uses `offline_access`:

   ```json
   {
     "mcpServers": {
       "docs": {
         "url": "https://mcp.example.com/mcp",
         "oauth": {
           "clientId": "docs-public-client",
           "scope": "offline_access",
           "callbackPort": 8765
         }
       }
     }
   }
   ```

   Put the entry in Pi's user-level `mcp.json` and in pid-acp's selected MCP config (they may be the same file). Use the same server name, normalized URL, and client ID in both. `callbackUrl` can specify a different HTTP loopback callback URI. Scope and callback settings are for Pi sign-in. Use only trusted MCP servers and authorization servers; pid-acp requires HTTPS except for loopback development.
2. Stop pid-acp and all other refreshers of this grant before login, logout, or reauthorization. Pi's browser flow and logout do not hold the refresh lock throughout. Wait for graceful shutdown; do not edit or replace the file while refresh is in progress.
3. From your workstation, forward the callback to the service host, then run login there in the service user's terminal:

   ```sh
   ssh -t -L 8765:127.0.0.1:8765 service@host
   PI_CODING_AGENT_DIR=/srv/pid-acp/pi pi mcp login docs
   ```

   Open the URL printed by Pi in your local browser. If you cannot forward the port, use Pi's TTY prompt to paste the URL to which your browser was redirected. Do not log or share that URL. If Pi says “already signed in” but there is no refresh grant, log out with `pi mcp logout docs` using the same agent directory and sign in with a grant that allows refresh.
4. Launch pid-acp with `PID_ACP_MCP_CONFIG=/srv/pid-acp/pi/mcp.json` and `PID_ACP_MCP_AUTH_FILE=/srv/pid-acp/pi/mcp-auth.json` for the example above. The defaults are `~/.pi/agent/mcp.json` and `~/.pi/agent/mcp-auth.json`; pid-acp does not read `PI_CODING_AGENT_DIR` to locate either file. Use the **actual live Pi file** in the service user's private directory (0700, file 0600), with no copies, symlinks or hard links. Keep it separate from session storage. Restart pid-acp after changes to the grant or configuration.

## Compatibility and failure behavior

- Only Pi 1.5.2's named store and pre-registered public bearer clients are supported. pid-acp does not migrate URL-only entries or support confidential clients, dynamic registration, client metadata documents, issuer overrides or OAuth command helpers. Pi normally does not record the configured client ID in a pre-registered grant, so pid-acp cannot verify that the matching ID was used at login. Always sign in with the same ID. Other HTTP entries still work without OAuth, including with static authorization headers.
- pid-acp sends the stored access token even near expiry and refreshes only after a server challenge, not on a timer. Redirects are rejected on MCP requests and OAuth discovery/token requests. A missing or revoked grant or insufficient scope needs operator sign-in. Discovery failure stops startup; later setup failures leave other servers usable and require restart to reconnect.
- pi-mcp can resend a challenged request **once** after successful recovery, including a tool POST. Only enable OAuth on servers that reject unauthorized mutations **before performing any effects**. pid-acp does not retry ambiguous failures; inspect the external system before repeating a mutation.
- Normal shutdown closes transports and waits for an ongoing rotation to save. If the existing process shutdown deadline is exceeded or the process is killed, rotation may be interrupted and reauthorization may be needed. Wait until all refreshers are stopped before running Pi login or logout.
