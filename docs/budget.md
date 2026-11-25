# Budget planner

With a new budget, the planner checks the drafting connection. Codex selects **Subscription plan**, local Ollama selects local inference, and a recognized API model selects its published rate card. Other connected models start with empty price fields. With no connection, the planner shows a named GPT-4.1 mini example. Saved budgets reopen with their own scenario and prices.

Set a daily job target with the slider or type an exact number. The live readout shows estimated daily cost, or estimated daily tokens for a subscription. Open **Token and pricing assumptions** to edit the low and high estimates for one role. Count input tokens for the prompt, profile and job details, and output tokens for the response. Include retries if they are part of your usual workflow.

The planner shows USD per day and across 30 days at the same target. Editing changes the projection immediately. **Save budget** stores the settings on this device. **Today** shows how many submissions have receipts against that target. Your saved scenario takes precedence even if you later switch draft providers. Choosing a scenario in the planner changes only the estimate. Firecrawl and other tool charges belong in the separate tool-cost field.

The cumulative chart opens at day 30. Point to a day, drag across the plot, or tap it to inspect days 0 through 30. With the chart focused, the arrow keys move one day and Home and End select the endpoints. The chart marker, amount and **Through day** column move together. The **Per day** column gives you the daily baseline. Exploring a day is temporary and requires no save.

![The forecast for five jobs per day, with the chart and cumulative total selected at day 15](images/day-15-forecast.png)

## Pricing scenarios

The connection shown under **Pricing scenario** is the provider and model configured for drafts. The dropdown identifies what you are pricing. You can compare a different scenario without changing the drafting connection.

| Scenario | USD per million input / output tokens | Price basis |
| --- | --- | --- |
| OpenAI GPT-4.1 mini | $0.40 / $1.60 | Standard uncached text, checked November 25, 2026. [OpenAI pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini) |
| Anthropic Claude Sonnet 4.6 | $3 / $15 | Standard direct API text, checked November 25, 2026. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| OpenRouter or another API model | Enter both rates from the provider | Routes, models and billing tiers can differ. **Price needed** means the workload and separate tool charges are available while the model cost is unknown. An explicit zero is supported for a free rate. |
| Local Ollama | $0 hosted inference | Add any paid tools. Hardware and electricity are outside this forecast. |
| Subscription plan | Enter the monthly fee if desired | The token range describes workload. Included usage depends on the model and task. [Codex plan usage](https://developers.openai.com/codex/pricing/) |

Each API scenario retains its own edited rates. Older budgets used $1 and $4 as generic example prices. The app keeps that pair visible for review and asks you to confirm it before applying it to another forecast. A new budget assumes 2,000 to 6,000 input tokens and 300 to 800 output tokens per job. These are example workloads. Use your provider’s reported usage for a representative complete application, including follow-up calls and retries, to calibrate them. Separately billed search, browser or other tools start at $0 per role until you enter their expected cost. Actual invoices can reflect cache discounts, additional charges, billing tiers and taxes.

At 25 jobs per day, the default token assumptions give 57,500 to 170,000 tokens per day. GPT-4.1 mini at the standard prices above gives $0.032 to $0.092 per day in model fees, or $0.96 to $2.76 over 30 days. Adding $0.02 in tools per job adds $15 over those 30 days.

If you enable the OmniRoute fallback, a zero input and output rate applies only to drafts handled by a verified free OpenRouter model. Estimate primary model usage and tool charges separately. The planner uses one pricing scenario at a time. [Free fallback setup](providers.md#free-fallback-with-omniroute)

## Calculation

For either end of the range, multiply input tokens by the input rate and output tokens by the output rate. Add those two amounts, divide by one million and multiply by the daily job target. Expected daily tool charges equal jobs per day multiplied by tool cost per role. The 30 day estimate uses 30 times the daily workload. Subscription mode spreads the supplied monthly fee across 30 days, including days with zero jobs. It adds the expected tool charges separately.

## Integration and checks

Mount the default export from `ui/Budget.jsx` with the standard `{ state, refresh, notify }` props. The panel reads the connected provider and model from public settings. A late response cannot replace a choice the user has edited or saved. Opening the panel does not write to the profile. The panel calls `workspace.saveProfile` with only `{ budget }` on explicit save. The workspace merges that field into the profile. Version 2 stores the scenario, daily job target, four token bounds, per-scenario prices and legacy price-review flags, per-role tool cost and nullable monthly subscription fee. Rate cards and calculations live in `ui/budget-estimate.mjs`.

Run `node --test tests/budget.test.mjs` for range arithmetic, subscription and local scenarios, validation, migration from partial settings, and persistence in an isolated workspace. After building the renderer, run `node tests/budget-initial-provider.mjs` to check initial provider selection and delayed responses in a disposable Electron window.

Run `node tests/budget-chart-smoke.mjs` after building the renderer to verify chart selection with a mouse, keyboard and emulated touch in Electron. Pass a renderer build directory as the first argument to test a separate build.
