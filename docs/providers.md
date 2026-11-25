# Provider connections

Open **Connections**, choose an AI provider, enter its model ID, then select **Use for drafts**. Pluto remembers a connection for each provider. One provider handles drafts at a time. Firecrawl is a separate connection for job discovery.

| Provider | Connection | What to enter |
| --- | --- | --- |
| OpenAI | OpenAI API key | Choose a model available to the key that supports Chat Completions. |
| Anthropic | Anthropic API key | Choose a Claude model available to the key that supports Messages. |
| OpenRouter | Sign in with OpenRouter or enter an API key | Approve access in the system browser. Inference uses the OpenRouter account’s credits. The model can be a routed model ID. |
| OpenAI compatible | HTTPS API base URL and the key for that address | Include the API prefix your service specifies, such as `https://api.example.com/v1`. Pluto appends `/chat/completions`. Enter the model ID supplied by that service. |
| Ollama | Local HTTP server with an installed model | The default address is `http://127.0.0.1:11434`. Enter the exact installed model name. Pluto checks the local model metadata before sending a prompt. |
| Firecrawl | Firecrawl API key | **Test connection** checks team credit access. A search uses Firecrawl credits. |

**Test model** sends a short sample prompt to the saved model. Hosted tests can incur a small inference charge. **Disconnect** removes that connection from this installation. To revoke an OpenRouter authorization at the provider, remove the corresponding key in [OpenRouter account settings](https://openrouter.ai/settings/keys).

## Data sent for a draft

Pluto sends the selected job’s title, company, description, location and salary, alongside the applicant’s name, summary, preferences and confirmed profile facts. For profiles created before fact selection was available, it uses the saved résumé text. Edited fact text takes precedence over the source résumé and selected excerpt. Search sends the entered query to Firecrawl. Drafting and discovery return results to the workspace for review.

## Desktop integration

`createProviders({ secrets, prefs, openExternal })` uses the storage interfaces in [architecture.md](architecture.md). Supply `openExternal(url)` to enable the optional OpenRouter sign-in button. The service constructs the authorization URL in main. An optional `fetchImpl` can be injected for tests. The Connections panel is a default export and accepts the standard panel props.

| IPC action | Payload | Result |
| --- | --- | --- |
| `providers.settings` | `{}` | `{ activeProvider, openRouterSignIn, providers }`. Each entry includes a label, base endpoint, configured flag and model for AI connections. |
| `providers.configure` | `{ provider, model?, endpoint?, apiKey?, auth? }` | Updated public settings. Saving an AI provider selects it for drafts. Omit the key to retain a credential already bound to the same address. Use `auth: "oauth"` for OpenRouter sign-in and `auth: "cancel"` to cancel pending sign-in. |
| `providers.disconnect` | `{ provider }` | Updated public settings. Disconnecting the active provider clears the selection. |
| `providers.test` | `{ provider }` | `{ ok: true }` after a successful model response or Firecrawl credit check. |
| `providers.draft` | `{ profile, job }` | Draft text as a string. |
| `providers.search` | `{ query }` | Up to ten web results, each with `title`, `url` and `description`. An empty array is a valid result. |

Provider IDs are `openai`, `anthropic`, `openrouter`, `custom`, `ollama` and `firecrawl`. Configuration is local. A test is the explicit connectivity check. Failed operations throw errors suitable for display.

## Credentials and sign-in

The main process stores keys through the injected secret store. Each saved key is bound to its full normalized API base URL. A custom address change requires a key entered for the new address. Requests reject redirects, and remote error bodies stay out of user messages.

OpenRouter sign-in uses a fresh S256 PKCE proof, a random callback path and a temporary IPv4 loopback listener on an OS-assigned port. Only the expected localhost host, port and callback path are accepted. The verifier stays in main memory. Main exchanges the code at OpenRouter’s fixed HTTPS endpoint, stores the returned API key, and closes the listener. Canceling, changing the AI connection or allowing the three-minute sign-in window to expire ends the pending flow. OpenAI and Anthropic connections use their developer API keys.

## Official API references

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth) and [Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [Ollama Chat](https://docs.ollama.com/api/chat), [model metadata](https://github.com/ollama/ollama/blob/main/api/types.go) and [cloud versus local inference](https://docs.ollama.com/cloud)
- [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search) and [Credit Usage](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage)

Run `node --test tests/providers.test.mjs` for provider contract, credential boundary, search and sign-in checks. Tests use fictional keys and a local callback listener.
