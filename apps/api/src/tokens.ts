// Explicit DI tokens. The build uses esbuild (no emitDecoratorMetadata), so every
// constructor dependency must be injected with @Inject(TOKEN).
export const IDENTITY_VERIFIER = Symbol("IDENTITY_VERIFIER");
export const USER_DIRECTORY = Symbol("USER_DIRECTORY");
export const LOGGER = Symbol("LOGGER");
export const CONNECTIONS = Symbol("CONNECTIONS");
export const ANSWERS = Symbol("ANSWERS");
export const PROPOSALS = Symbol("PROPOSALS");
export const AUDIT = Symbol("AUDIT");
export const CONVERSATIONS = Symbol("CONVERSATIONS");
export const AGENTS = Symbol("AGENTS");
export const WEB_APP_URL = Symbol("WEB_APP_URL");
