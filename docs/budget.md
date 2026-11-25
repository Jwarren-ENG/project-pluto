# Budget planner

Open **Daily budget** and enter the number of jobs you plan to work on each day. A new planner starts with GPT-6.2 Sol. If you have a drafting connection, Pluto selects the matching API model, local inference, or your subscription. An unrecognized API model starts with blank price fields. Comparing scenarios changes the forecast. **Save budget** stores the target and assumptions on this device.

## Pricing scenarios

These are standard, uncached text prices checked on November 25, 2026, in US dollars per million tokens. Use the provider’s reported billable output, including reasoning tokens, when estimating an actual application. Discounts for caching or batch requests, regional surcharges and taxes can change the bill.

| Model | Input | Output | Billing basis |
| --- | ---: | ---: | --- |
| GPT-6.2 Sol | $2 | $10 | Standard through 272,000 input tokens per request. [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.2-sol) |
| GPT-6.2 Astra | $8 | $40 | Same threshold. For longer requests both OpenAI models charge twice the input rate and 1.5 times the output rate. [OpenAI](https://developers.openai.com/api/docs/models/gpt-6.2-astra) |
| Claude Sonnet 5.5 | $2 | $10 | Global standard API. [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Opus 5.5 | $4 | $20 | Global standard API. [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Haiku 5.5 | $0.10 | $0.50 | Through 100,000 input tokens per request. Above that, use $0.50 input and $2.50 output. [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Claude Fable 5.2 | $8 | $40 | Global standard API. [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) |
| Gemini 4 Carbon and Argon | $2 | $10 | Paid Developer API through November 30. From December 1 both cost $4 input and $20 output. The forecast applies the published change on that date. [Google](https://aistudio.google.com/docs/pricing#gemini-4-carbon) |
| Gemini 4 Neon | $3 | $15 | Paid Developer API, including thinking tokens in output. [Google](https://aistudio.google.com/docs/pricing#gemini-4-neon) |
| Gemini 4 Hydrogen | $1.50 | $7.50 | Paid Developer API. Use your own rates if eligible for free usage. [Google](https://aistudio.google.com/docs/pricing#gemini-4-hydrogen) |
| Grok 4.7 | $2 | $6 | Global endpoint, below 200,000 input tokens per request. At or above that threshold use $4 and $12. [xAI](https://docs.x.ai/developers/pricing) |

**Token and pricing assumptions** lets you enter a price for another model, an OpenRouter route or a different billing tier. If one large request triggers a premium, enter the rates that apply to it. A job can make several shorter requests, so the combined tokens per job alone cannot establish a context premium. A verified zero is a valid free rate. **Price needed** means the provider has a cost the planner cannot yet calculate.

Ordinary API forecasts show gross usage in dollars before prepaid balances or promotions. A dollar-denominated API balance pays for usage at the provider’s applicable rates. Count paid searches, Firecrawl and separately billed tools in the per-job tool field.

### Subscriptions and purchased credits

Choose **Subscription plan** to estimate token workload against your included plan. Enter the optional monthly fee to see its allocation across 30 days. Your plan and usage history determine how much of your allowance remains.

For personal ChatGPT Work or Codex usage paid from purchased credits, choose the model’s **Codex credits** scenario. At Standard speed, Sol uses 50 credits per million uncached input tokens and 250 per million output tokens. Astra uses 200 and 1,000 respectively. The planner shows credits for the modeled workload if it is entirely billed as overage. Separate tools remain in dollars. [OpenAI credit rates](https://developers.openai.com/codex/pricing/)

### Running an open model locally

Choose **Local inference** for a model running on your own computer, such as gpt-oss-20b in Ollama. Enter the average watts, active minutes per job and electricity price in USD per kWh. Measure power at the wall during a representative run and time the whole job, including retries. To estimate the extra cost on a computer you would leave on anyway, enter the difference between active and idle watts. Cloud hosting an open model incurs the host’s charges. [OpenAI open model](https://openai.com/index/introducing-gpt-oss/) · [How electricity is measured](https://www.eia.gov/energyexplained/electricity/measuring-electricity.php)

The starting 60 W and 2 to 6 minutes per job are illustrative. The starting $0.1817 per kWh is the September 2026 US residential average. Use your bill for a local estimate. At 100 jobs per day the example consumes 0.2 to 0.6 kWh, or about $0.04 to $0.11 per day. Hardware purchase and idle time outside these runs are excluded. [EIA monthly electricity prices](https://www.eia.gov/electricity/monthly/epm_table_grapher.php?t=epmt_5_6_a)

## Calculation

Each job starts with 2,000 to 6,000 input tokens and 300 to 800 output tokens. Replace these examples with the total billable usage across the calls that produce one finished application.

- **API dollars** = jobs × (input tokens × input rate + output tokens × output rate) ÷ 1,000,000, plus separate tools. At 100 jobs per day, GPT-6.2 Sol costs $0.70 to $2.00 per day, or $21 to $60 over 30 days before tools.
- **Purchased credits** use the same arithmetic with the model’s credit rates. The same workload on GPT-6.2 Sol uses 17.5 to 50 credits per day when billed to purchased credits.
- **Electricity** = jobs × average watts × active minutes per job ÷ 60,000 × USD per kWh. Adding 2 cents in paid tools to 100 local jobs adds $2 per day.

The chart starts at day 30. Point to a day, drag or tap to read its cumulative totals. Use the arrow keys, Home or End with the chart focused. Day 1 is today in the device’s calendar. Published Gemini rates change within the projection where applicable. A manually edited price applies throughout the forecast.

Older budgets using untouched GPT-4.1 mini or Sonnet 4.6 example prices move to the current model in the same family. Job targets and edited prices carry over. An explicitly connected older model can still show its own rate. The planner never calls a paid model to calculate an estimate.

![Daily budget with GPT-6.2 Sol selected and the cumulative forecast at day 15](images/day-15-forecast.png)

Current rate cards and effective dates live in `ui/budget-prices.mjs`. Update this catalog and the source links when providers publish new prices. Run `node --test tests/budget*.test.mjs` for calculation and upgrade checks, then `npm run build` and `npm run smoke:interactions` to exercise the planner in Electron.
