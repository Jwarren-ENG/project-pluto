// These are user-operated sign-ins. None grants Pluto an inference endpoint or a credential.
const grokCli = 'https://docs.x.ai/build/cli/reference'
const antigravity = 'https://antigravity.google/docs/install'

const providers = [
  {
    id: 'grok', label: 'Grok',
    options: [
      {
        id: 'cli', kind: 'terminal', label: 'Sign in to Grok Build',
        command: ['grok', 'login'], documentation: grokCli,
        instructions: 'Use the official Grok Build CLI. Run the command in your terminal and finish signing in with xAI in your browser.',
      },
      {
        id: 'device', kind: 'terminal', label: 'Use a Grok Build device code',
        command: ['grok', 'login', '--device-auth'], documentation: grokCli,
        instructions: 'Run the command in your remote terminal. Follow the verification address and code shown by Grok and approve the request yourself.',
      },
      {
        id: 'native', kind: 'app', label: 'Use the Grok mobile app',
        documentation: 'https://docs.x.ai/grok/overview',
        instructions: 'Open the official Grok app on iOS or Android and sign in there.',
      },
      {
        id: 'web', kind: 'browser', label: 'Open Grok',
        url: 'https://grok.com/', documentation: 'https://docs.x.ai/grok/overview',
        instructions: 'Open Grok in your browser and choose Sign in.',
      },
    ],
  },
  {
    id: 'gemini', label: 'Gemini',
    options: [
      {
        id: 'cli', kind: 'terminal', label: 'Use Antigravity CLI with a personal Google account',
        command: ['agy'], documentation: antigravity,
        instructions: 'Start the official Antigravity CLI in a directory you choose. If prompted, select Google OAuth and finish in your browser. This is the CLI for personal Free, Google AI Pro and Ultra accounts.',
      },
      {
        id: 'enterprise-cli', kind: 'terminal', label: 'Use Gemini CLI with an organization license',
        command: ['gemini'], documentation: 'https://geminicli.com/docs/get-started/authentication/',
        instructions: 'Use this route with an eligible organization license for Gemini Code Assist. Start the official Gemini CLI, choose Sign in with Google and complete the browser sign-in. Your organization may need to configure a Google Cloud project.',
      },
      {
        id: 'native', kind: 'app', label: 'Use the Antigravity desktop app',
        documentation: antigravity,
        instructions: 'Open the official Antigravity app, choose Sign in and finish in your browser. Google manages the local session shared with Antigravity CLI.',
      },
      {
        id: 'web', kind: 'browser', label: 'Open Gemini',
        url: 'https://gemini.google.com/app', documentation: 'https://support.google.com/gemini/answer/13278668',
        instructions: 'Open Gemini in your browser and sign in with your Google account.',
      },
    ],
  },
]

/**
 * list() is passive. Call handoff({ provider, method }) only after a user chooses a route.
 * A trusted desktop caller can supply openExternal(url), e.g. Electron's shell.openExternal.
 * Terminal and native options return steps for the user. Commands are display-only argv;
 * an interactive CLI can access its working directory, so the user chooses where to run it.
 * 'opened' means the browser opener resolved. 'manual' means instructions are available.
 * Neither result supplies an identity, verifies entitlement, or enables drafting.
 */
export function createAccountClis({ openExternal } = {}) {
  return {
    list() {
      return structuredClone(providers)
    },

    async handoff(request) {
      const { provider, method } = request ?? {}
      const account = providers.find(entry => entry.id === provider)
      const option = account?.options.find(entry => entry.id === method)
      if (!option) throw new Error('Choose a supported account sign-in option.')

      let status = 'manual'
      if (option.kind === 'browser' && openExternal) {
        try {
          await openExternal(option.url)
        } catch {
          throw new Error('The browser could not be opened. Open the provider website yourself.')
        }
        status = 'opened'
      }
      return { provider, option: structuredClone(option), status }
    },
  }
}
