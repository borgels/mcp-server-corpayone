import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { SecretRedactor } from './gateway-redactor.js';
import { admitsKey, KEY_REFUSED, leaksSecret, maskedText, sealedError } from './key-admission.js';
import { redactDeep, redactText } from './redaction.js';
import { writeGatewayAuditEvent } from './corpay/gateway-audit.js';
import { basicCredentials, CorpayGatewayClient, type CorpayEnvironment } from './corpay/gateway-client.js';
import { failureMetadata, vendorRequestId, type FailureMetadata } from './corpay/gateway-errors.js';
import { GATEWAY_TOOLS, scrub, type GatewayClientView, type GatewayTool } from './corpay/gateway-tools.js';
import {
  canonicalToolName,
  currentInstancePolicy,
  GatewayConfigError,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type CallContext,
  type InstancePolicy,
  type ResolvedInstancePolicy,
} from './corpay/gateway-scope.js';

// Re-exported so an embedding host can validate inbound Corpay One
// webhooks and filter event types without reaching into package internals.
export { validateWebhookSignature } from './corpay/webhooks.js';
export { WEBHOOK_EVENTS } from './corpay/catalog.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. The tools and their inputs live in
 * src/corpay/gateway-tools.ts, and the typed answers (an allow-list of fields
 * per answer type) in src/corpay/gateway-answers.ts. The pattern scrub below
 * is an extra guard on top.
 *
 * One instance per company (Corpay One team). Several instances can run in
 * one process. Each instance uses only what the host passes: the app's
 * client id and secret, the company's refresh token and the team id. It
 * reads no CORPAYONE_* variable at all (not the credentials, not the team,
 * not the environment or the addresses, not the write or approval switches,
 * not the policy file, not the audit log). Redirects are never followed.
 *
 * The team is a hard boundary: every list is asked for that team, and a
 * resource addressed by id (an expense) is read first and refused unless it
 * belongs to the team.
 *
 * When Corpay One renews the access with a new refresh token, the instance
 * uses it at once and gives it to the host (`onRefreshToken`) before it sends
 * anything else.
 *
 * Changes are sent directly when the host's policy enables writes: there is
 * no prepare and commit step here, since the host decides who may change what
 * and records a change before it is sent. Approving an expense is marked
 * `requiresConfirmation` in the catalog, because it releases the bill for
 * payment; whether a person confirms it, and how, is the host's decision.
 *
 * Every call runs in a call scope of its own (AsyncLocalStorage), so a call
 * made from inside another instance's call never inherits that instance's
 * policy, sink, redactor or caller.
 */

export type { AuditSink, InstancePolicy } from './corpay/gateway-scope.js';
export { GatewayConfigError } from './corpay/gateway-scope.js';
export { KEY_REFUSED } from './key-admission.js';
export { CORPAY_ORIGINS, type CorpayEnvironment } from './corpay/gateway-client.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status Corpay One answered with,
 * and its request id when a response header gives one as a UUID or hex id. Never the response body, Corpay's error
 * code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from Corpay One only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

/** Who and which request a call belongs to; written to the audit records of the call. */
export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One Corpay One API request a tool may make: the method and the path template under /external. */
export interface GatewayUpstreamOperation {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly path: string;
}

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  /** Every Corpay One request the tool may make. Empty for a tool that does not call Corpay One. */
  readonly upstream: readonly GatewayUpstreamOperation[];
  /** True when the tool can read more than its name says. No Corpay One gateway tool is broad. */
  readonly broad: boolean;
  /**
   * True for a change a person should confirm outside the chat before it runs: approving an expense, which releases
   * the bill for payment. False for every other tool.
   */
  readonly requiresConfirmation: boolean;
}

export interface CorpayGatewayOptions {
  /** The app's client id at Corpay One (from app.corpayone.com/developers). Required; not a secret. */
  clientId: string;
  /** The app's client secret. Required; a secret. */
  clientSecret: string;
  /** The refresh token the company's consent gave (offline_access). Required; a secret. */
  refreshToken: string;
  /** The Corpay One team (company) this instance acts for: a hard boundary. Required. */
  teamId: string;
  /** Which Corpay One to talk to. Default production; addresses are fixed per environment. */
  environment?: CorpayEnvironment;
  /**
   * Called with a new refresh token when Corpay One hands one out while renewing the access. The instance uses it
   * from then on; a host that stores tokens saves it here. The call waits for it, and a rejection stops the call
   * before anything is sent.
   */
  onRefreshToken?: (refreshToken: string) => void | Promise<void>;
  /** The fetch to use (tests, or a host's own). Redirects are never followed either way. */
  fetchImpl?: typeof fetch;
  /** Time limit per request in milliseconds. Default 30 seconds; never read from the environment. */
  timeoutMs?: number;
  /**
   * Instance policy from the host. Without it the instance uses the default policy (no writes, no disabled tools,
   * no audit records); it never reads a policy or audit variable from the environment.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the same zod schema the call is validated with. `format` and
 * `pattern` are dropped: validators such as Ajv reject unknown formats in strict mode, and zod checks the values
 * when the call runs.
 */
function toJsonSchema(schema: z.ZodType): GatewayJsonObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
      delete (ctx.jsonSchema as Record<string, unknown>).pattern;
    },
  }) as Record<string, unknown>;
  return json as GatewayJsonObject;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

/** Strict input schemas: an unknown field is refused, not dropped. */
const SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map(GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, z.strictObject(tool.input)]));
const BY_NAME: ReadonlyMap<string, GatewayTool> = new Map(GATEWAY_TOOLS.map(tool => [`${TOOL_PREFIX}${tool.name}`, tool]));
const GATEWAY_TOOL_NAMES: readonly string[] = [...BY_NAME.keys()];

function definition(tool: GatewayTool): GatewayToolDefinition {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    riskLevel: tool.riskLevel,
    enabledByDefault: tool.riskLevel === 'read',
    inputSchema: toJsonSchema(SCHEMAS.get(`${TOOL_PREFIX}${tool.name}`)!),
  };
}

/** All gateway tools, as definitions (names without the prefix). */
export const corpayGatewayTools: GatewayToolDefinition[] = GATEWAY_TOOLS.map(definition);

/**
 * The tool catalog: every gateway tool with its definition, the upstream requests it may make, the broad mark and
 * whether a person should confirm it. Deeply frozen; a host can build its permission model from it without creating
 * an instance.
 */
export const corpayToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  GATEWAY_TOOLS.map(tool => ({
    ...definition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    requiresConfirmation: tool.requiresConfirmation === true,
  })),
);

/** KEY_REFUSED with every run that shares a piece with any of the secrets masked, so it holds no piece of one. */
function refusedText(field: string, secrets: readonly unknown[]): string {
  return secrets.reduce<string>((text, secret) => maskedText(text, secret), `${field}: ${KEY_REFUSED}`);
}

const ID_FORM = /^[A-Za-z0-9_-]{1,100}$/;
const CLIENT_ID_FORM = /^[!-9;-~]{1,200}$/;

function requiredSecret(options: Partial<CorpayGatewayOptions>, name: 'clientSecret' | 'refreshToken', given: readonly unknown[]): string {
  const value: unknown = options[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new GatewayConfigError(`createCorpayGateway requires options.${name}. Embedded instances do not read credentials from the environment.`);
  }
  // Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
  // ours. Checked before anything is built from it; the refusal is a fixed text that holds no piece of it.
  if (!admitsKey(value.trim())) throw new GatewayConfigError(refusedText(`options.${name}`, given));
  return value.trim();
}

/** A caller id from the host: redacted before it is cut short, so no part of a secret survives. */
function contextValue(value: unknown, redactor: SecretRedactor): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? redactor.redact(value.trim()).slice(0, 200) : undefined;
}

/**
 * Create one gateway instance for one Corpay One team. `clientId`, `clientSecret`, `refreshToken` and `teamId` are
 * required and are the only credentials the instance uses; a missing or refused value fails here, before anything is
 * built or sent.
 */
export function createCorpayGateway(options: CorpayGatewayOptions) {
  const raw = (options ?? {}) as Partial<CorpayGatewayOptions>;
  const secrets = (['clientSecret', 'refreshToken'] as const).flatMap(name => {
    const value: unknown = raw[name];
    return typeof value === 'string' && value !== '' ? [value, value.trim()] : [];
  });
  const guard = new SecretRedactor();
  try {
    for (const form of secrets) guard.addSecret(form);
    const clientSecret = requiredSecret(raw, 'clientSecret', secrets);
    const refreshToken = requiredSecret(raw, 'refreshToken', secrets);
    if (clientSecret === refreshToken) throw new GatewayConfigError(refusedText('options', secrets));
    const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
    if (!CLIENT_ID_FORM.test(clientId)) {
      throw new GatewayConfigError('createCorpayGateway requires options.clientId. Embedded instances do not read credentials from the environment.');
    }
    const teamId = typeof raw.teamId === 'string' ? raw.teamId.trim() : '';
    if (!ID_FORM.test(teamId)) {
      throw new GatewayConfigError('createCorpayGateway requires options.teamId (a Corpay One team id). Embedded instances do not read it from the environment.');
    }
    const environment = raw.environment ?? 'production';
    if (environment !== 'production' && environment !== 'staging') {
      throw new GatewayConfigError('options.environment must be "production" or "staging".');
    }
    guard.addSecret(basicCredentials(clientId, clientSecret));
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of a secret.
    if (leaksSecret(fixedOutputs(), guard)) throw new GatewayConfigError(refusedText('options', secrets));
    const gateway = buildCorpayGateway(raw, { clientId, clientSecret, refreshToken, teamId, environment }, guard);
    // The tool list leaves the gateway as it is: a secret that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) throw new GatewayConfigError(refusedText('options', secrets));
    return gateway;
  } catch (error) {
    let message = guard.redact(error instanceof Error ? error.message : String(error));
    if (leaksSecret(message, guard)) message = refusedText('options', secrets);
    // A fresh error in final form (src/key-admission.ts, sealedError), then the sink check on the finished object.
    const final = sealedError(new GatewayConfigError(message), ...secrets);
    if (leaksSecret(final, guard)) throw sealedError(new GatewayConfigError(refusedText('options', secrets)), ...secrets);
    throw final;
  }
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  teamId: string;
  environment: CorpayEnvironment;
}

function buildCorpayGateway(options: Partial<CorpayGatewayOptions>, credentials: Credentials, redactor: SecretRedactor) {
  // Only these options are read; anything else a host passes is dropped.
  const { policy: hostPolicy, fetchImpl, timeoutMs, onRefreshToken } = options;
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new GatewayConfigError('options.fetchImpl must be a function.');
  if (onRefreshToken !== undefined && typeof onRefreshToken !== 'function') throw new GatewayConfigError('options.onRefreshToken must be a function.');
  // Always a policy: the host's, or the default one. A gateway call never reads policy or audit variables.
  const policy: ResolvedInstancePolicy = resolveInstancePolicy(hostPolicy ?? {}, GATEWAY_TOOL_NAMES);
  let client: CorpayGatewayClient;
  try {
    client = new CorpayGatewayClient({
      ...credentials,
      redactor,
      ...(fetchImpl ? { fetchImpl } : {}),
      ...(onRefreshToken ? { onRefreshToken } : {}),
      timeoutMs,
      exposed: corpayGatewayTools,
    });
  } catch (error) {
    throw new GatewayConfigError(error instanceof Error ? error.message : 'Invalid options.');
  }
  const offeredNames: ReadonlySet<string> = new Set(GATEWAY_TOOL_NAMES.filter(name => !policy.disabledTools.has(name)));
  const offered: readonly GatewayTool[] = GATEWAY_TOOLS.filter(tool => offeredNames.has(`${TOOL_PREFIX}${tool.name}`));

  return {
    /** Tools enabled on this instance (tools the host's policy disables are left out). */
    tools: corpayGatewayTools.filter(tool => !policy.disabledTools.has(canonicalToolName(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      return runInCallScope(
        {
          policy,
          redactor,
          caller: contextValue(context?.caller, redactor),
          // Our own id for the call: the host's request id is its text, and is not written to the audit.
          requestId: randomUUID(),
          offeredTools: offeredNames,
        },
        () =>
          runCall(toolName, input).then(result => {
            // Every result is scrubbed, also an error that quotes the input: no bank or card number and no signed link leaves.
            const final = withFailureInForm(redactDeep(scrub(result), redactor) as GatewayToolResult);
            // The sink check, as the very last step: a result that holds a piece of a secret anywhere is withheld whole.
            return leaksSecret(final, redactor) ? withheldResult() : final;
          }),
      );
    },
  };

  async function runCall(toolName: string, input: GatewayJsonObject): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? canonicalToolName(toolName) : '';
      const tool = BY_NAME.get(name);
      const schema = SCHEMAS.get(name);
      if (!tool || !schema) {
        await writeGatewayAuditEvent({ tool: UNKNOWN_TOOL, action: 'rejected', reason: 'unsupported tool' });
        return errorResult('Unsupported Corpay One gateway tool.');
      }
      const parsed = schema.safeParse(input ?? {});
      if (!parsed.success) {
        await writeGatewayAuditEvent({ tool: name, action: 'rejected', reason: 'invalid input' });
        return errorResult(redactText(`Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}`, redactor));
      }
      const values = parsed.data as Record<string, unknown>;
      const denied = policyDenial(name, tool);
      const target = { expenseId: values.expenseId, vendorId: values.vendorId };
      if (denied) {
        await writeGatewayAuditEvent({ tool: name, action: 'policy_denied', target, reason: denied });
        return errorResult(denied);
      }
      await writeGatewayAuditEvent({ tool: name, action: 'start', target });
      let data: unknown;
      try {
        data = await tool.run(tool.riskLevel === 'read' ? readOnly(client, tool.name) : client, values, { teamId: credentials.teamId, offered });
      } catch (error) {
        await writeGatewayAuditEvent({ tool: name, action: 'error', target, status: 'error', error });
        throw error;
      }
      await writeGatewayAuditEvent({ tool: name, action: 'finish', target, status: 'ok' });
      // Every answer is scrubbed here as well, on top of its type, whatever the tool did: no bank or card number and no signed link leaves.
      return jsonResult(tool.summary, redactDeep(redactDeep(scrub(data), redactor), redactor));
    } catch (error) {
      return errorResult(redactText(error instanceof Error ? error.message : String(error), redactor), failureMetadata(error));
    }
  }
}

/** Why the host's policy refuses a tool, or undefined when it may run. */
function policyDenial(name: string, tool: GatewayTool): string | undefined {
  const policy = currentInstancePolicy()!;
  if (policy.disabledTools.has(name)) return 'This tool is disabled on this instance by the embedding host.';
  if (tool.riskLevel !== 'read' && !policy.enableWrites) return 'Writes are disabled. The embedding host has not enabled writes for this instance.';
  return undefined;
}

/**
 * A view of the client that can only read: a read tool that tries to change something is refused. It delegates to the
 * client itself, so the access and a renewed token are shared with every other call of the instance.
 */
function readOnly(client: CorpayGatewayClient, tool: string): GatewayClientView {
  return {
    get: (path, query) => client.get(path, query),
    send: async () => {
      throw new Error(`Read tool ${tool} attempted a change in Corpay One; refused.`);
    },
  };
}

const UNKNOWN_TOOL = 'unknown_tool';

/** One gateway instance, as returned by createCorpayGateway. */
export type CorpayGateway = ReturnType<typeof createCorpayGateway>;

/** The summary, then the same (already redacted) data as compact JSON in the text block. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  const data = JSON.parse(JSON.stringify(structuredContent ?? null)) as GatewayJsonValue;
  return { content: [{ type: 'text', text: `${text}\n\n${JSON.stringify(data)}` }], structuredContent: data };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return { isError: true, content: [{ type: 'text', text }], ...(failure ? { failure } : {}) };
}

/** The failure metadata as it must be after redaction: on an error result only, in form. Anything else is dropped. */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const status = failure.httpStatus;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return rest;
  const requestId = vendorRequestId(failure.requestId);
  return { ...rest, failure: requestId === undefined ? { httpStatus: status } : { httpStatus: status, requestId } };
}
