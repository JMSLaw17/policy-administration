import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { downloadSignedDocument } from "@/lib/integrations/docusign";

/** The signed application, with DocuSign's certificate, for the broker or the policyholder who signed it. */
export async function GET(_request: Request, ctx: RouteContext<"/api/applications/[id]/document">) {
  const user = await getCurrentUser();
  if (!user) return new Response("Sign in first", { status: 401 });

  const { id } = await ctx.params;
  const application = await db.application.findUnique({ where: { id } });
  const allowed = user.role === "BROKER" || (application && application.customerId === user.customerId);
  if (!application || !allowed) return new Response("Not found", { status: 404 });
  if (!application.docusignEnvelopeId || !application.signedAt) {
    return new Response("This application hasn't been signed yet.", { status: 409 });
  }

  const pdf = await downloadSignedDocument(application.docusignEnvelopeId);
  return new Response(pdf, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="signed-application-${application.id}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
}
