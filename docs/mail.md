# Job email

Connect one Gmail and one Outlook account in **Job email**. Choose a tracked job, then select **Search inbox**. Each search looks for the employer’s name in that account’s inbox and returns up to 15 possible matches. Opening the tab only checks local connection status. Searching, opening a message, and linking it are separate actions.

Select a result to review the sender, subject, received time and available excerpt. **Read original message** opens the provider’s website in your system browser. Verify the company and position, especially when the same company has multiple openings. **Link reply to this job** saves a local note attached to the selected job. It records the mailbox, sender, subject, date, and original message reference. Include the excerpt only if you want it in the workspace and future Markdown exports. Repeating the link preserves the existing note and any edits. The job’s stage, receipt and submitted résumé are preserved.

## Bring your own registration

### Gmail

1. Create or select a project in Google Cloud and enable the Gmail API.
2. Configure the OAuth consent screen and audience. For an external app in testing, add the mailbox owner as a test user. Workspace administrators may require additional approval for restricted Gmail scopes.
3. Create an OAuth client of type **Desktop app**. Copy its client ID and any issued desktop client secret into Pluto. Google desktop clients support an ephemeral loopback redirect. Pluto uses the root path on the IPv4 loopback address.
4. Select **Connect Gmail** and approve read access in the system browser. Pluto requests `https://www.googleapis.com/auth/gmail.readonly` and offline access. It confirms the selected address through Gmail’s profile endpoint. External apps in testing can have short lived refresh grants.

[Google desktop OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app) · [Gmail authorization scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

### Outlook

1. In Microsoft Entra, create an app registration that supports **accounts in any organizational directory and personal Microsoft accounts**. Pluto uses the public Microsoft cloud and its common authority.
2. Under **Authentication**, add **Mobile and desktop applications**, then register this exact redirect URI: `http://localhost/pluto/outlook`. Microsoft matches the localhost path and permits Pluto to choose an available port. Choose the native/public client platform.
3. Add delegated Microsoft Graph permissions **User.Read** and **Mail.Read**. Pluto requests **offline_access** to renew the session. The account or its organization must allow these permissions.
4. Enter the **Application (client) ID** in Pluto and select **Connect Outlook**. The provider returns the account identity via Graph’s profile endpoint. Outlook desktop sign-in uses a public client and has no client secret field.

[Microsoft desktop registration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration) · [Authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow) · [Localhost redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url#localhost-exceptions)

## Privacy and recovery

Both providers use a system browser, a single use OAuth state, and S256 PKCE. Each attempt opens a fresh port bound to IPv4 loopback, checks the callback host and path, and closes on completion, denial, cancellation, launch failure or timeout. Cancel sign-in from Pluto if you close the provider tab. Sign-in expires after three minutes; inbox search expires after 45 seconds.

Refresh credentials, account metadata and any Google desktop client secret share one encrypted record per provider in the main process secret store. Access tokens stay in memory. Scan results stay in the open panel until you change the job, switch accounts, leave the panel, or search again. Pluto requests message summaries and does not retrieve attachments or send, mark, move, or delete messages. Disconnecting removes the saved local connection. To revoke the grant at the provider too, use your Google or Microsoft account’s app permissions page. A revoked grant requires reconnecting.

## Desktop and panel integration

The four existing mail actions take a single object. The default Mail panel takes `{state, refresh, notify}`.

| Action | Payload | Result |
| --- | --- | --- |
| `mail.settings` | `{}` | Array of `{provider, email, busy, error?}` for both providers. An empty email means no usable connection. |
| `mail.connect` | `{provider, clientId, clientSecret?}` | Connected `{provider, email}` after verifying identity and saving the grant. |
| `mail.scan` | `{provider, company}` | Array of `{key, provider, account, from, subject, receivedAt, preview, url}`. Empty excerpt or link means the provider supplied none that Pluto could display. |
| `mail.disconnect` | `{provider}` | Clears local credentials and returns `{provider, email: ''}`. |

Provider values are `gmail` and `outlook`. Sending `{provider, cancel: true}` to the same connect or scan action cancels the pending operation and waits for cleanup. Other simultaneous actions on the same account are rejected. The main process may call `mail.close()` during shutdown to abort outstanding requests and release listeners. This is a lifecycle method only.

The review step uses existing `workspace.snapshot` and `workspace.saveNote` actions with a stable note ID and selected job ID. It does not require a database migration, new IPC action or package dependency.

## Fixture verification

From the project root, run `node --test tests/mail.test.mjs`. The tests use synthetic accounts and provider responses. They exercise real ephemeral loopback callbacks, both provider flows, PKCE, cancellation, secure storage boundaries, read-only searches, token rotation, and reviewed linking against a temporary local workspace. No mailbox credentials are required.

[Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) · [Microsoft Graph message search](https://learn.microsoft.com/en-us/graph/search-query-parameter#use-search-on-message-collections)
