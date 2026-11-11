import "server-only";
import { createPrivateKey, createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { logIntegrationEvent } from "./log";

/**
 * DocuSign eSignature, developer sandbox only (account-d / demo hosts).
 *
 * We authenticate as our own DocuSign user with the JWT grant: sign a short
 * token with our RSA key, swap it for an access token, and cache that until
 * shortly before it expires.
 */

const AUTH_HOST = "account-d.docusign.com"; // "-d" is the sandbox

export class DocuSignNotConfiguredError extends Error {
  constructor() {
    super("DocuSign isn't set up yet.");
    this.name = "DocuSignNotConfiguredError";
  }
}
export class DocuSignError extends Error {}

function privateKeyPem(): string | null {
  const encoded = process.env.DOCUSIGN_PRIVATE_KEY_BASE64;
  if (encoded) return Buffer.from(encoded, "base64").toString("utf8");
  // Local development convenience: a git-ignored key file in the project folder.
  const file = path.join(process.cwd(), "docusign_private.pem");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

function config() {
  const integrationKey = process.env.DOCUSIGN_INTEGRATION_KEY;
  const userId = process.env.DOCUSIGN_USER_ID;
  const accountId = process.env.DOCUSIGN_ACCOUNT_ID;
  const pem = privateKeyPem();
  if (!integrationKey || !userId || !accountId || !pem) return null;
  return { integrationKey, userId, accountId, pem };
}

export const isDocuSignConfigured = () => config() !== null;

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

let cached: { token: string; baseUri: string; expiresAt: number } | null = null;

async function session() {
  const cfg = config();
  if (!cfg) throw new DocuSignNotConfiguredError();
  if (cached && cached.expiresAt > Date.now() + 60_000) return { ...cached, accountId: cfg.accountId };

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cfg.integrationKey,
      sub: cfg.userId,
      aud: AUTH_HOST,
      iat: now,
      exp: now + 600,
      scope: "signature impersonation",
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(createPrivateKey(cfg.pem));
  const assertion = `${header}.${claims}.${base64url(signature)}`;

  const tokenResponse = await fetch(`https://${AUTH_HOST}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const tokenBody = await tokenResponse.json();
  if (!tokenResponse.ok) {
    throw new DocuSignError(
      tokenBody.error === "consent_required"
        ? "DocuSign consent hasn't been granted for this integration key yet."
        : `DocuSign sign-in failed: ${tokenBody.error_description ?? tokenBody.error ?? tokenResponse.status}`,
    );
  }

  // Ask DocuSign which server hosts this account.
  const info = await fetch(`https://${AUTH_HOST}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${tokenBody.access_token}` },
  }).then((r) => r.json());
  const account = (info.accounts ?? []).find((a: { account_id: string }) => a.account_id === cfg.accountId);
  if (!account) throw new DocuSignError("The DocuSign account id doesn't belong to this DocuSign user.");
  if (!/^https:\/\/[a-z0-9.-]*demo[a-z0-9.-]*\.docusign\.net$/i.test(account.base_uri)) {
    throw new DocuSignError("This demo only runs against the DocuSign developer sandbox.");
  }

  cached = {
    token: tokenBody.access_token,
    baseUri: account.base_uri,
    expiresAt: Date.now() + tokenBody.expires_in * 1000,
  };
  return { ...cached, accountId: cfg.accountId };
}

async function api(pathname: string, init?: RequestInit) {
  const s = await session();
  const response = await fetch(`${s.baseUri}/restapi/v2.1/accounts/${s.accountId}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new DocuSignError(`DocuSign: ${body.message ?? body.errorCode ?? response.status}`);
  }
  return response;
}

export type Signer = { name: string; email: string; clientUserId: string };

/** Sends a document for signature. The signer signs inside our app, not by email. */
export async function createEnvelope(input: {
  subject: string;
  documentName: string;
  documentHtml: string;
  signer: Signer;
  /** Public URL DocuSign should call when the envelope changes, if we have one. */
  webhookUrl?: string;
  applicationId: string;
}): Promise<string> {
  const body = {
    emailSubject: input.subject,
    status: "sent",
    documents: [
      {
        documentId: "1",
        name: input.documentName,
        fileExtension: "html",
        documentBase64: Buffer.from(input.documentHtml).toString("base64"),
      },
    ],
    recipients: {
      signers: [
        {
          recipientId: "1",
          routingOrder: "1",
          name: input.signer.name,
          email: input.signer.email,
          // Marks this as an embedded signer: they sign in our app.
          clientUserId: input.signer.clientUserId,
          tabs: {
            // Placed wherever these marker strings appear in the document.
            signHereTabs: [{ anchorString: "/sig1/", anchorUnits: "pixels", anchorYOffset: "-6" }],
            dateSignedTabs: [{ anchorString: "/date1/", anchorUnits: "pixels", anchorYOffset: "-6" }],
          },
        },
      ],
    },
    customFields: { textCustomFields: [{ name: "applicationId", value: input.applicationId, show: "false" }] },
    ...(input.webhookUrl && {
      eventNotification: {
        url: input.webhookUrl,
        requireAcknowledgment: "true",
        loggingEnabled: "true",
        deliveryMode: "SIM",
        events: ["envelope-completed", "envelope-declined", "envelope-voided"],
        eventData: { version: "restv2.1", format: "json" },
      },
    }),
  };
  const response = await api("/envelopes", { method: "POST", body: JSON.stringify(body) });
  const result = await response.json();
  await logIntegrationEvent({
    provider: "docusign",
    direction: "OUTBOUND",
    eventType: "envelope.create",
    externalId: result.envelopeId,
    payload: { status: result.status, applicationId: input.applicationId, signer: input.signer.email },
  });
  return result.envelopeId as string;
}

/** A one-time link that opens the signing screen for this signer. */
export async function createSigningUrl(envelopeId: string, signer: Signer, returnUrl: string): Promise<string> {
  const response = await api(`/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    body: JSON.stringify({
      returnUrl,
      authenticationMethod: "none",
      userName: signer.name,
      email: signer.email,
      clientUserId: signer.clientUserId,
    }),
  });
  await logIntegrationEvent({
    provider: "docusign",
    direction: "OUTBOUND",
    eventType: "envelope.recipient_view",
    externalId: envelopeId,
    payload: { signer: signer.email },
  });
  return (await response.json()).url as string;
}

export type EnvelopeStatus = { status: string; completedAt: string | null };

export async function getEnvelopeStatus(envelopeId: string): Promise<EnvelopeStatus> {
  const envelope = await (await api(`/envelopes/${envelopeId}`)).json();
  return { status: envelope.status, completedAt: envelope.completedDateTime ?? null };
}

export async function voidEnvelope(envelopeId: string, reason: string) {
  await api(`/envelopes/${envelopeId}`, {
    method: "PUT",
    body: JSON.stringify({ status: "voided", voidedReason: reason }),
  });
  await logIntegrationEvent({
    provider: "docusign",
    direction: "OUTBOUND",
    eventType: "envelope.void",
    externalId: envelopeId,
    payload: { reason },
  });
}

/** The signed document plus DocuSign's certificate of completion, as one PDF. */
export async function downloadSignedDocument(envelopeId: string): Promise<ArrayBuffer> {
  const response = await api(`/envelopes/${envelopeId}/documents/combined?certificate=true`, {
    headers: { accept: "application/pdf" },
  });
  return response.arrayBuffer();
}
