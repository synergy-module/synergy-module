# Robinhood Support request

**Subject: Custom hosted MCP integration — redirect URI rejected after verification**

Please escalate this to the team responsible for Agentic Trading / Trading MCP OAuth.

We are integrating Synergy, a hosted trading research application, with Robinhood's official Trading MCP at `https://agent.robinhood.com/mcp/trading`.

The planned application domains are `synergymodule.dev` and `synergymodule.app`; subdomains may also be used. Please confirm how each exact HTTPS callback must be registered, including future subdomains.

Our current beta callback is:

```text
https://beta.omensite.com/auth/robinhood/callback
```

After sign-in and verification, `https://api.robinhood.com/oauth2/authorize/` returns:

```json
{"detail":"Mismatching Redirect URI: https://beta.omensite.com/auth/robinhood/callback"}
```

The app sends this identical URI in dynamic client registration and the authorization request. Public registration checks on September 24, 2026 returned HTTP 200 and echoed each of two requested callback URIs, while returning the same client ID and the name `Robinhood Trading`. No authorization code reaches our callback. We use the authorization-code flow, scope `internal`, resource `https://agent.robinhood.com/mcp/trading`, PKCE S256, and public-client authentication (`token_endpoint_auth_method=none`).

Could you confirm:

1. Are independent hosted web applications with HTTPS OAuth callbacks and server-side token storage supported?
2. Is this failure a registration issue, a client-specific callback restriction, or an unsupported deployment model?
3. If registration review or approval is required, what is the process, what requirements apply, and what review timeframe should we expect?
4. If hosted integration is supported, how should we obtain a working client registration for our two domains and any required subdomain callbacks?

Our application supports a provider-issued public client ID with PKCE; it does not use a client secret. If this integration type is not currently supported, please confirm the supported deployment model for an independently developed application.

Please provide a case/reference number for this request.

## Submission record

- Submitted through the signed-in Robinhood support chat on September 27, 2026; the chat displayed the message as sent at 12:32 AM.
- Included `synergymodule.dev`, `synergymodule.app`, possible future subdomains, the current beta callback failure, and the technical registration findings.
- Requested a human agent; Robinhood routed the conversation to **Agentic trading account support** and confirmed it would notify the user when an agent joins.
- The displayed estimate before entering the queue was **3 hours 15 minutes**. No case/reference number or integration approval had been issued at submission time.
