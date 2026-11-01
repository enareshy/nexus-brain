export type SetupStep = {
  readonly text: string;
  readonly href?: string;
  readonly linkLabel?: string;
};

export type SetupGuide = {
  readonly idLabel: string;
  readonly secretLabel: string;
  /** Where to find the two values once the provider has created them. */
  readonly steps: readonly SetupStep[];
  /** Shown next to the redirect address when the provider asks for it. */
  readonly note?: string;
};

function githubAppUrl(redirectUrl: string): string {
  const params = new URLSearchParams({
    name: "Nexus Brain",
    description: "Read-only sign-in for Nexus Brain.",
    url: "https://github.com/enareshy/nexus-brain",
    public: "false",
    webhook_active: "false",
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  });
  return `https://github.com/settings/apps/new?${params}&callback_urls[]=${encodeURIComponent(redirectUrl)}`;
}

/** Step-by-step setup per service. Only services that need an app appear here. */
export function setupGuideFor(serverId: string, redirectUrl: string): SetupGuide | null {
  switch (serverId) {
    case "github":
      return {
        idLabel: "Client ID",
        secretLabel: "Client secret",
        steps: [
          {
            text: "Create the app. The form is already filled in with read-only access. GitHub names must be unique, so change the name if it is taken.",
            href: githubAppUrl(redirectUrl),
            linkLabel: "Open GitHub",
          },
          { text: "On the next page, copy the Client ID, then click Generate a new client secret and copy that." },
          { text: "Click Install App in the left menu and choose the repositories Nexus Brain may read." },
        ],
      };
    case "slack":
      return {
        idLabel: "Client ID",
        secretLabel: "Client secret",
        note: "Paste this under Redirect URLs. Slack may require an https address, in which case this works only once Nexus Brain is deployed.",
        steps: [
          {
            text: "Create an app from scratch in your workspace. Slack allows only internal or Marketplace apps here.",
            href: "https://api.slack.com/apps?new_app=1",
            linkLabel: "Create Slack app",
          },
          {
            text: "Under OAuth & Permissions, add the address below as a redirect URL, and add these user token scopes: search:read.public, search:read.private, channels:history, groups:history.",
          },
          { text: "Under Basic Information, copy the Client ID and Client Secret." },
          { text: "If your workspace requires it, ask a workspace admin to approve the app." },
        ],
      };
    case "google-drive":
    case "gmail":
      return {
        idLabel: "Client ID",
        secretLabel: "Client secret",
        note: "Paste this under Authorized redirect URIs.",
        steps: [
          {
            text: "This one setup covers both Google Drive and Gmail. Create a project, or choose one you already have.",
            href: "https://console.cloud.google.com/projectcreate",
            linkLabel: "Create project",
          },
          {
            text: "Enable the Google Drive API.",
            href: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
            linkLabel: "Enable Drive API",
          },
          {
            text: "Enable the Drive MCP API.",
            href: "https://console.cloud.google.com/apis/library/drivemcp.googleapis.com",
            linkLabel: "Enable Drive MCP API",
          },
          {
            text: "Enable the Gmail API.",
            href: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
            linkLabel: "Enable Gmail API",
          },
          {
            text: "Enable the Gmail MCP API.",
            href: "https://console.cloud.google.com/apis/library/gmailmcp.googleapis.com",
            linkLabel: "Enable Gmail MCP API",
          },
          {
            text: "Click Get started and fill in the app name and your email. Choose Internal if your company uses Google Workspace, otherwise External.",
            href: "https://console.cloud.google.com/auth/overview",
            linkLabel: "Set up sign-in",
          },
          {
            text: "If you chose External, add each person's email under Test users.",
            href: "https://console.cloud.google.com/auth/audience",
            linkLabel: "Add test users",
          },
          {
            text: "Create a client: choose Web application, add the address below as a redirect URI, then copy the Client ID and secret.",
            href: "https://console.cloud.google.com/auth/clients/create",
            linkLabel: "Create client",
          },
        ],
      };
    default:
      return null;
  }
}
