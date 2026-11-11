import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { syncApplication } from "@/lib/policies/applications";

/**
 * Where DocuSign sends the policyholder after the signing screen. Whatever
 * the address says happened, we ask DocuSign for the envelope's real status.
 */
export async function GET(_request: Request, ctx: RouteContext<"/portal/applications/[id]/signed">) {
  const user = await requireUser("POLICYHOLDER");
  const { id } = await ctx.params;
  const application = await db.application.findUnique({ where: { id } });
  if (application && application.customerId === user.customerId) {
    try {
      await syncApplication(id);
    } catch (error) {
      console.error("Could not check application with DocuSign", error);
    }
  }
  redirect("/portal");
}
