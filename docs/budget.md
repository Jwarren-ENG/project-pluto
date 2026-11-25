# Budget planner

Set a daily job target with the slider or type an exact number. Enter low and high estimates for input and output tokens across all calls for one role. Input includes the prompt, profile and job details. Output includes tokens billed for the response. Include retries in the estimates if they are part of your usual workflow.

The planner shows USD per day and across 30 days at the same target. Editing changes the projection immediately. **Save budget assumptions** stores the current settings on this device. The planner operates independently of discovery schedules and provider connections.

## Pricing scenarios

| Scenario | Starting input / output rate per million tokens | Basis |
| --- | --- | --- |
| OpenAI GPT-4.1 mini | $0.40 / $1.60 | Standard uncached pricing checked November 25, 2026. [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| Anthropic Claude Sonnet 4.6 | $3 / $15 | Standard pricing checked November 25, 2026. [Anthropic model pricing](https://platform.claude.com/docs/en/models/sonnet-4-6/overview) |
| OpenRouter and custom API | $1 / $4 | Illustrative rates. Enter the selected model and account’s actual input and output rates before using the estimate. |
| Local Ollama | $0 provider fee | Hardware and electricity are outside the estimate. Paid tools can still incur charges. |
| Subscription | Optional monthly fee supplied by the user | Shows estimated jobs and tokens. Entitlements and usage limits depend on the plan. A blank fee leaves the total unspecified. |

Each hosted API scenario retains its own edited rates. The generic workload starts at 10 jobs per day, 2,000 to 6,000 input tokens and 300 to 800 output tokens per role. Tool cost starts at $0 per role. Enter an expected cost for Firecrawl or other separately billed services. These starting assumptions are editable. Discounts, cached input pricing, taxes and tiered billing require adjustments to the assumptions.

## Calculation

For either end of the range, multiply input tokens by the input rate and output tokens by the output rate. Add those two amounts, divide by one million and multiply by the daily job target. Expected daily tool charges equal jobs per day multiplied by tool cost per role. The 30 day estimate uses 30 times the daily workload. Subscription mode spreads the supplied monthly fee across 30 days, including days with zero jobs. It adds the expected tool charges separately.

## Integration and checks

Mount the default export from `ui/Budget.jsx` with the standard `{ state, refresh, notify }` props. The panel reads `state.profile.budget` and calls `workspace.saveProfile` with only `{ budget }` on explicit save. The workspace merges that field into the profile. Version 1 stores the scenario, daily job target, four token bounds, per-provider rate overrides, per-role tool cost and nullable monthly subscription fee. Rate cards and calculations live in `ui/budget-estimate.mjs`.

Run `node --test tests/budget.test.mjs` for range arithmetic, subscription and local scenarios, validation, migration from partial settings, and persistence in an isolated workspace.
