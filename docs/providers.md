# Provider connections

## Draft with a ChatGPT subscription

1. Install the official Codex CLI on the computer running Pluto. Check the installation with `codex --version`. [Codex CLI installation](https://developers.openai.com/codex/cli/)
2. In **Connections → AI for drafts**, select **ChatGPT subscription · Codex**. Select **Use subscription for drafts** if Codex is already signed in. Otherwise, select **Sign in with ChatGPT** and complete the official browser login. If Codex reports a different login method, switch to ChatGPT in Codex and select **Refresh status**. Codex manages the credentials. [OpenAI sign-in guide](https://developers.openai.com/codex/auth/)
3. With Codex selected for drafts, open a saved role in **Applications** and select **Draft with AI**. Review the text before using it. Access and usage are governed by your ChatGPT plan’s Codex limits. [Codex plan access and limits](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

A new **Daily budget** starts with estimated subscription workload when this connection is active. The planner lets you model tool charges separately. OpenAI and Anthropic API requests, OpenRouter inference and Firecrawl searches each use their own account billing. Pluto’s Anthropic integration requires an API key. [Budget planner](budget.md)

## Other connections

For a developer API connection, choose **API or local model**, select a provider and model, then select **Use for drafts**. This sets the primary drafting provider. Firecrawl supplies job discovery separately.

| Provider | Connection | What to enter |
| --- | --- | --- |
| OpenAI | OpenAI API key | Choose a model available to the key that supports Chat Completions. |
| Anthropic | Anthropic API key | Choose a Claude model available to the key that supports Messages. |
| Google Gemini | Gemini API key | Choose a text model from the Google model list in Connections. |
| xAI Grok | xAI API key | Choose a text model available to your xAI account. |
| OpenRouter | Sign in with OpenRouter or enter an API key | Approve access in the system browser. Inference uses the OpenRouter account’s credits. The model can be a routed model ID. |
| OpenAI compatible | HTTPS API base URL and the key for that address | Include the API prefix your service specifies, such as `https://api.example.com/v1`. Pluto appends `/chat/completions`. Enter the model ID supplied by that service. |
| Ollama | Local HTTP server with an installed model | The default address is `http://127.0.0.1:11434`. Enter the exact installed model name. Pluto checks the local model metadata before sending a prompt. |
| Firecrawl | Firecrawl API key | **Test connection** checks team credit access. A search uses Firecrawl credits. |

The ChatGPT subscription check verifies the Codex sign-in. **Test model** for an API or local model sends a short sample prompt. Hosted tests can incur a small inference charge. **Disconnect** removes that connection from this installation. To revoke an OpenRouter authorization at the provider, remove the corresponding key in [OpenRouter account settings](https://openrouter.ai/settings/keys).

## Choose a drafting model

Open **Connections → AI for drafts** and select your provider. Use **Load models** or **Refresh models** to fetch its list. Models with dates appear newest first, followed by undated entries in the provider’s order. Ollama uses local modification dates for installed models. Your saved model stays selected across refreshes, even if it drops out of the list.

A new Claude connection starts with Sonnet 5.5. Opus 5.5, Haiku 5.5 and Fable 5.2 are also available in the picker before you enter a key. Loading the account list shows the models that Anthropic returns for that key. Daily budget has rates for each of the four models and uses the Sonnet 4.6 rate for a connection explicitly saved with that model. [Claude models](https://platform.claude.com/docs/en/models/overview) · [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)

Choose a model and select **Use for drafts** or **Save connection**. If the list is unavailable, you can enter a model ID manually. For a ChatGPT subscription, keep **Account default** to let Codex choose, or select a model and use **Save subscription model** when the connection is active. To estimate API costs, enter the chosen model’s published rates in **Daily budget**. [Budget guide](budget.md#pricing-scenarios)

## Using an account you already have

OpenDesign 0.26.1 hands local work to each provider’s installed program. It starts Claude Code for Claude, Codex for ChatGPT, Antigravity for Google and Grok Build for xAI. Those programs handle their own sign-in. OpenDesign also supports entering a provider API key for a direct connection. [OpenDesign provider adapters](https://github.com/nexu-io/open-design/tree/ac476788b7393f491df7d511c1c3b2d43b35e0fb/apps/daemon/src/runtimes/defs)

In Pluto, **Use subscription for drafts** can reuse an existing Codex session signed in with ChatGPT. When you request a draft, Pluto starts a temporary, read-only Codex session. Claude, Gemini and Grok drafts use the API connection in the table above. The Google and Grok sign-in instructions open the provider’s own account flow. After that, drafting in Pluto still requires the corresponding API connection. Daily budget lets you compare a model’s price before you connect it.

## Free fallback with OmniRoute

In **Connections → Free drafting fallback**, turn on **Enable free drafting fallback**. In the dialog, use your saved OpenRouter key or enter a dedicated key, then select **Enable fallback**. Pluto downloads the free model catalog and sets up the local OmniRoute gateway in the background. Return to Connections to see the current step and bytes downloaded. Turn the switch off during setup to cancel. [OmniRoute project](https://github.com/cheaper-inference/OmniRoute)

When the status reads **Ready for drafting**, a quota limit from your primary provider can trigger a retry. The local gateway sends the same reviewed profile and job details to the official OpenRouter service and the provider serving its free model. In **Fallback model**, **Automatic (free models)** lets OpenRouter choose, or you can select a specific available free model. Free capacity and request limits still apply. Disabling the fallback or quitting Pluto stops the managed gateway. [OpenRouter free models](https://openrouter.ai/collections/free-models) · [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits)

## Data sent for a draft

Pluto sends the selected job’s title, company, description, location and salary, alongside the applicant’s name, summary, preferences and confirmed profile facts. For profiles created before fact selection was available, it uses the saved résumé text. Edited fact text takes precedence over the source résumé and selected excerpt. Search sends the entered query to Firecrawl. Drafting and discovery return results to the workspace for review.

## Desktop integration

`createProviders({ secrets, prefs, openExternal, codex })` uses the storage interfaces in [architecture.md](architecture.md). The `codex` adapter handles the installed CLI’s sign-in and drafting. Supply `openExternal(url)` to enable the optional OpenRouter sign-in button. The service constructs the authorization URL in main. An optional `fetchImpl` can be injected for tests. The Connections panel is a default export and accepts the standard panel props.

| IPC action | Payload | Result |
| --- | --- | --- |
| `providers.settings` | `{}` | `{ activeProvider, openRouterSignIn, providers }`. Entries include public configuration information. `activeProvider: "codex"` identifies the selected ChatGPT subscription. |
| `providers.subscriptionStatus` | `{}` | Public Codex availability and sign-in state. |
| `providers.models` | `{ provider, endpoint?, apiKey? }` | Model entries with ordering, source and retrieval time. |
| `providers.configure` | `{ provider, model?, endpoint?, apiKey?, auth? }` | Updated public settings. Saving an AI provider selects it for drafts. Omit the key to retain a credential already bound to the same address. Use `provider: "codex"` for an existing ChatGPT sign-in or add `auth: "login"` for official browser login. OpenRouter uses `auth: "oauth"`. Both support `auth: "cancel"`. |
| `providers.disconnect` | `{ provider }` | Updated public settings. Disconnecting the active provider clears the selection. |
| `providers.test` | `{ provider }` | `{ ok: true }` after a successful Codex sign-in check, model response or Firecrawl credit check. |
| `providers.draft` | `{ profile, job }` | Draft text as a string. |
| `providers.search` | `{ query }` | Up to ten web results, each with `title`, `url` and `description`. An empty array is a valid result. |

Provider IDs are `codex`, `openai`, `anthropic`, `gemini`, `xai`, `openrouter`, `custom`, `ollama` and `firecrawl`. Configuration is local. A test is the explicit connectivity check. Failed operations throw errors suitable for display.

## Credentials and sign-in

Disconnecting the Codex provider removes its Pluto connection preference. Codex manages its own ChatGPT session. The main process stores developer API keys through the injected secret store. Each saved key is bound to its full normalized API base URL. A custom address change requires a key entered for the new address. Requests reject redirects, and remote error bodies stay out of user messages.

OpenRouter sign-in uses a fresh S256 PKCE proof, a random callback path and a temporary IPv4 loopback listener on an OS-assigned port. Only the expected localhost host, port and callback path are accepted. The verifier stays in main memory. Main exchanges the code at OpenRouter’s fixed HTTPS endpoint, stores the returned API key, and closes the listener. Canceling, changing the AI connection or allowing the three-minute sign-in window to expire ends the pending flow. OpenAI and Anthropic connections use their developer API keys.

## Official API references

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth) and [Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [Ollama Chat](https://docs.ollama.com/api/chat), [model metadata](https://github.com/ollama/ollama/blob/main/api/types.go) and [cloud versus local inference](https://docs.ollama.com/cloud)
- [Firecrawl Search](https://docs.firecrawl.dev/api-reference/endpoint/search) and [Credit Usage](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage)

Run `node --test tests/providers.test.mjs` for provider contract, credential boundary, search and sign-in checks. Tests use fictional keys and a local callback listener.
