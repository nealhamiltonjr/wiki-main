// The app's built-in setting definitions (§7.10b). This module is imported
// once on each side: the server imports it for validation + boot-time
// consumption, the client imports it to render the admin Settings UI. Keep
// keys stable — they are stored in system_settings and read by services.
import { registerSetting } from "./settings.js";

// -- General -----------------------------------------------------------------
registerSetting({
  key: "site.name",
  section: "General",
  label: "Site name",
  type: "text",
  default: "Wiki",
  help: "Shown in the login page and public view.",
});

registerSetting({
  key: "general.publicMode",
  section: "General",
  label: "Public mode",
  type: "select",
  default: "off",
  options: [
    { value: "off", label: "Off — login required for everything" },
    { value: "on", label: "On — unauthenticated visitors see the public view" },
  ],
  help: "Whether unauthenticated visitors see the public-facing site.",
});

registerSetting({
  key: "general.defaultTheme",
  section: "General",
  label: "Default theme",
  type: "select",
  default: "light",
  options: [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "contrast", label: "Contrast" },
  ],
});

registerSetting({
  key: "general.defaultEditorWidth",
  section: "General",
  label: "Default editor width",
  type: "select",
  default: "full",
  options: [
    { value: "full", label: "Full width" },
    { value: "narrow", label: "Narrow (reading width)" },
  ],
});

registerSetting({
  key: "general.allowSignup",
  section: "General",
  label: "Allow public sign-up",
  type: "boolean",
  default: true,
  help: "When off, only admins can create accounts.",
});

// -- Email -------------------------------------------------------------------
registerSetting({
  key: "smtp_host",
  section: "Email",
  label: "SMTP host",
  type: "text",
  help: "e.g. smtp.gmail.com",
});

registerSetting({
  key: "smtp_port",
  section: "Email",
  label: "SMTP port",
  type: "number",
  default: 587,
  help: "465 uses implicit TLS; 587/25 use STARTTLS.",
});

registerSetting({
  key: "smtp_user",
  section: "Email",
  label: "SMTP username",
  type: "text",
});

registerSetting({
  key: "smtp_pass",
  section: "Email",
  label: "SMTP password / app password",
  type: "secret",
});

registerSetting({
  key: "smtp_from",
  section: "Email",
  label: "From address",
  type: "text",
  default: "wiki@localhost",
});

// -- Git (content repo) ------------------------------------------------------
registerSetting({
  key: "git_remote_url",
  section: "Git",
  label: "Remote URL",
  type: "text",
  help: "HTTPS or SSH URL of the content repository remote (e.g. https://github.com/user/wiki-content.git).",
});

registerSetting({
  key: "git_remote_token",
  section: "Git",
  label: "Remote token",
  type: "secret",
  help: "HTTPS personal access token / app password for the remote. Never stored in plaintext.",
});

registerSetting({
  key: "git_remote_branch",
  section: "Git",
  label: "Remote branch",
  type: "text",
  default: "main",
  help: "Branch this instance pushes to / pulls from on the remote.",
});

// -- Sync --------------------------------------------------------------------
registerSetting({
  key: "sync_target_url",
  section: "Sync",
  label: "Default sync target URL",
  type: "text",
  help: "Base URL of another wiki instance to sync spaces to by default.",
});

registerSetting({
  key: "sync_target_token",
  section: "Sync",
  label: "Default sync target token",
  type: "secret",
  help: "API token on the target instance with edit permissions on the destination spaces.",
});

// -- Security ----------------------------------------------------------------
registerSetting({
  key: "security.trustedOrigins",
  section: "Security",
  label: "Extra trusted origins",
  type: "textarea",
  help: "Comma-separated origins allowed to make authenticated requests (beyond the configured base URL).",
});
