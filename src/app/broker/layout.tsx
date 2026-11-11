import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth";

export default async function BrokerLayout({ children }: LayoutProps<"/broker">) {
  const user = await requireUser("BROKER");
  return (
    <AppShell user={user} nav={[
        { href: "/broker", label: "Customers" },
        { href: "/broker/commissions", label: "Commissions" },
        { href: "/broker/integrations", label: "Integration log" },
      ]}>
      {children}
    </AppShell>
  );
}
