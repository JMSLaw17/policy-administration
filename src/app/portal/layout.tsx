import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";

export default async function PortalLayout({ children }: LayoutProps<"/portal">) {
  const user = await requireUser("POLICYHOLDER");
  return (
    <AppShell user={user} nav={[{ href: "/portal", label: "My policies" }]}>
      {children}
    </AppShell>
  );
}
