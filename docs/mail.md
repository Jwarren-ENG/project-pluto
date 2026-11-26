# Connect a job inbox

Open **Connections → Email** and choose **Connect Gmail** or **Connect Outlook**. If your copy includes a provider registration, your browser opens Google or Microsoft. Select an account, approve read access, then return to Project Pluto. The connected address appears beside the provider.

On a Mac without a provider registration, the same button opens the Apple Mail account picker. Allow macOS to show your Mail accounts, then choose the address you use for applications. Project Pluto will show that address **via Apple Mail** and check the selected account for recruiting replies. If the address is missing, add it using **Mail → Add Account** in Apple's Mail app and choose **Check again**. The separate **Connect Apple Mail** option uses the combined inbox.

On Windows, a distribution without a provider registration asks for a desktop client ID from its administrator. The sections below explain how to configure one for everyone who installs the app. Email permission is independent of the AI subscription used for drafting.

Email setup is in **Connections → Email**. In **Applications**, review submission receipts and interview scheduling updates against the role they belong to. For an application asking for an email verification code, open that role and request its recent code. Codes stay out of notes, submission receipts and interview history.

## Set up one click sign-in for a distribution

A publisher can configure the desktop clients once so end users only need to grant permission. Use a Google **Desktop app** client and a Microsoft **public desktop** client registered for Pluto. Set the repository variables `PLUTO_GOOGLE_DESKTOP_CLIENT_ID` and `PLUTO_OUTLOOK_DESKTOP_CLIENT_ID`. When Google issues a desktop client secret, set the Actions secret `PLUTO_GOOGLE_DESKTOP_CLIENT_SECRET`. The desktop build includes only those native registrations. Everything shipped in a public desktop application is recoverable by its users, so use only credentials intended for installed apps. Complete the providers’ consent verification or tenant approval before broad distribution. Google Drive can use the same registered client and asks separately for its own permission.

For a local distribution, supply the same settings to `node build/register-oauth.mjs` before packaging. User tokens stay in the system protected local store.

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

## Fixture verification

From the project root, run `node --test tests/mail.test.mjs`. The tests use synthetic accounts and provider responses. They exercise real ephemeral loopback callbacks, both provider flows, PKCE, cancellation, secure storage boundaries, read-only searches, token rotation, and reviewed linking against a temporary local workspace. No mailbox credentials are required.

[Gmail message list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list) · [Microsoft Graph message search](https://learn.microsoft.com/en-us/graph/search-query-parameter#use-search-on-message-collections)

Turn on **Email checker** under **Connections → Optional workflows** to use these actions. Switching it off keeps the linked account and stops further mailbox checks from Pluto.
