# Project Pluto

Project Pluto is a local job search dashboard for macOS and Windows that works with **Claude** and **ChatGPT via Codex**. It brings your #LOCKEDIN Job Kit tracker and optional Obsidian notebook into one place. Open Today to follow interviews, review receipts, and pick up your search. [Connecting an existing workspace](docs/job-kit.md)

[Download the desktop app](https://github.com/Jwarren-ENG/project-pluto/releases/latest) · [Getting started with pictures](docs/getting-started.md) · [Installation guide](docs/install.md) · [License](LICENSE)

## Use Claude or Codex

| How you want to work | Where to start |
| --- | --- |
| Draft in Pluto with **Claude** | Open **Connections → AI for drafts → Claude**. Enter your Anthropic API key, choose a Claude model, and select **Use for drafts**. Anthropic bills these drafts to your API account. [Claude setup](docs/providers.md#draft-with-claude) |
| Work in **Claude Code** with your existing Job Kit | Under **Today → Job Kit workflow**, choose **Show workflow** and connect your kit folder. Select a task, choose **Copy task**, and paste it into Claude Code with access to that folder. This uses your Claude Code session. [Job Kit walkthrough](docs/job-kit.md) |
| Draft in Pluto with **ChatGPT via Codex** | Install the Codex CLI, then open **Connections → AI for drafts → ChatGPT**. Choose **Use subscription for drafts** if you’re already signed in, or **Sign in with ChatGPT**. [Codex setup](docs/providers.md#draft-with-a-chatgpt-subscription) |

Prefer Claude in your browser? Paste the starter into a private Claude chat, then upload your résumé when prompted. [Job Kit chat starter](https://github.com/Jwarren-ENG/lockedin-job-kit/blob/main/CHAT_STARTER.txt)

![The Today view with fictional application records and an upcoming interview](docs/preview.png)

Save your own job lists under **Discover → Sources**. [Job source guide](docs/sources.md)

## Start your search

1. Open **Today** and choose **Add résumé**. Import a file or paste your experience. Review the extracted facts and confirm the details you want saved. Add stories from work, school or personal projects and choose which ones can appear in drafts. Keep private answers such as your salary range and availability in Profile for employer forms. [Profile guide](docs/profile.md)
2. In **Daily budget**, move the jobs per day slider to see estimated workload or cost. A new budget uses the connected model’s rate card when available. For other API models, enter their prices. Compare current API prices, purchased Codex credits, subscription workload, or the electricity for running a local model. Save your target to track daily progress on Today. [Budget guide](docs/budget.md)
3. Go to **Applications** to save a job from its employer's posting. For an assisted search, configure Firecrawl in **Connections** and enter a role and location under **Discover**. The daily discovery option runs while the app is open.
4. Open a saved role to prepare your materials. With a provider connected, you can request a draft based on confirmed experience, edit it and save your reviewed résumé as a PDF. Open the employer's application, fill in the form and submit on the employer's site. Right click inside the form or press Command Shift F on Mac or Control Shift F on Windows to fill supported contact fields.
5. Record the employer confirmation and change the stage to **Applied**. The application retains a copy of the résumé text, draft and evidence saved at that moment. For an interview, add the invitation and appointment time.

Open **Connections → Optional workflows** to turn on study guides, interview prep, email checking or auto apply separately. Each switch shows the setup it needs. [Workflow guide](docs/getting-started.md#choose-optional-workflows)

## Connect the services you use

| To do this | Open |
| --- | --- |
| Draft with Claude via the Anthropic API, ChatGPT via Codex, another API provider, or local Ollama | [AI providers and search](docs/providers.md) |
| Review relevant Gmail or Outlook replies and associate one with an application | [Mail setup](docs/mail.md) |
| Save a reviewed résumé PDF to your Google Drive | [Google Drive setup](docs/drive.md) |
| Keep Markdown notes or exchange them with an optional Obsidian vault | [Workspace and vault](docs/workspace.md) |

Choose your drafting model in **Connections → AI for drafts**. Refresh the provider’s list to see dated models newest first, followed by undated models in the provider’s order. Your saved choice stays selected. [Model chooser](docs/providers.md#choose-a-drafting-model)

If your primary provider reaches its quota, you can opt into a fallback through OpenRouter’s free models. Enabling it requires an OpenRouter API key and installs a managed local OmniRoute gateway in the background. Connections shows setup progress. Turning the fallback off or quitting Pluto stops the gateway. [Free fallback setup](docs/providers.md#free-fallback-with-omniroute)

On first launch, you can connect an existing job kit or start with a new profile. It keeps your records in the current operating system user's application data directory. API credentials use operating system protected encryption. Your résumé, job records and notes are stored locally in a database. A vault export creates readable Markdown files in the folder you choose. Select a private folder if your materials contain personal information.

Hosted API requests, OpenRouter inference and Firecrawl searches use their respective accounts and billing. Local Ollama has a $0 hosted model fee. The app can also track applications and notes without a provider.

## Run from source

Install Node.js 24 and npm. In the project folder, run:

```sh
npm ci
node node_modules/electron/install.js
npm start
```

Run `npm test` for the component and service checks. Run `npm run build` followed by `npm run smoke` to test the actual desktop window in a temporary workspace. Use `npm run dist` to build the installer on a supported platform. See the [desktop architecture](docs/architecture.md) and [third party credits](THIRD_PARTY.md).

For a guided workflow inside a chat assistant, see the [#LOCKEDIN Job Kit](https://github.com/Jwarren-ENG/lockedin-job-kit).
